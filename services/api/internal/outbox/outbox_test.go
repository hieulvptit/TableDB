package outbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestFailedJobsLogRetryAndExhaustion(t *testing.T) {
	previous := slog.Default()
	defer slog.SetDefault(previous)
	for _, maxAttempts := range []int{2, 1} {
		var output bytes.Buffer
		slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
		q := &leaseDB{owner: 1}
		job := Job{ID: 17, Type: "email", Attempts: 1, MaxAttempts: maxAttempts, Payload: []byte(`{"token":"private-payload"}`)}
		failed, err := execute(context.Background(), q, map[string]Handler{"email": func(context.Context, Job) error {
			return fmt.Errorf("SMTP connection refused")
		}}, nil, job, time.Minute)
		if err != nil || !failed {
			t.Fatalf("execute: failed=%v err=%v", failed, err)
		}
		var entry map[string]any
		if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["job_id"] != float64(17) || entry["job_type"] != "email" || entry["attempt"] != float64(1) || entry["error"] == nil {
			t.Fatalf("missing job diagnostics: %v", entry)
		}
		if maxAttempts == 2 && (entry["level"] != "WARN" || entry["retry_in_sec"] == nil) {
			t.Fatal("missing retry diagnostics")
		}
		if maxAttempts == 1 && entry["level"] != "ERROR" {
			t.Fatal("exhausted retries were not logged as an error")
		}
		if strings.Contains(output.String(), "private-payload") {
			t.Fatal("job payload leaked into diagnostics")
		}
	}
}

// Model ownership changes independently of the worker, as another replica can.
type leaseDB struct {
	mu               sync.Mutex
	owner            int
	renewals, writes int
}

func (q *leaseDB) Query(context.Context, string, ...any) (pgx.Rows, error) { panic("unused") }
func (q *leaseDB) QueryRow(context.Context, string, ...any) pgx.Row        { panic("unused") }
func (q *leaseDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if args[1].(int) != q.owner {
		return pgconn.NewCommandTag("UPDATE 0"), nil
	}
	if strings.Contains(sql, "SET locked_until=") {
		q.renewals++
	} else {
		q.writes++
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func TestExecutionRenewsLeaseAndStopsHeartbeat(t *testing.T) {
	q := &leaseDB{owner: 1}
	job := Job{ID: 1, Type: "slow", Attempts: 1, MaxAttempts: 8}
	_, err := execute(context.Background(), q, map[string]Handler{"slow": func(ctx context.Context, _ Job) error {
		deadline := time.After(time.Second)
		for {
			q.mu.Lock()
			n := q.renewals
			q.mu.Unlock()
			if n >= 3 {
				return nil
			}
			select {
			case <-deadline:
				return fmt.Errorf("no renewals")
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Millisecond):
			}
		}
	}}, nil, job, 30*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	q.mu.Lock()
	before, writes := q.renewals, q.writes
	q.mu.Unlock()
	if writes != 1 {
		t.Fatalf("result writes=%d", writes)
	}
	time.Sleep(40 * time.Millisecond)
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.renewals != before {
		t.Fatal("heartbeat leaked after execution")
	}
}
func TestLostLeaseCancelsHandlerAndFencesResult(t *testing.T) {
	q := &leaseDB{owner: 1}
	dead := false
	_, err := execute(context.Background(), q, map[string]Handler{"slow": func(ctx context.Context, _ Job) error {
		q.mu.Lock()
		q.owner = 2
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return fmt.Errorf("cancelled")
		case <-time.After(time.Second):
			return fmt.Errorf("handler not cancelled")
		}
	}}, func(context.Context, Job, error) { dead = true }, Job{ID: 1, Type: "slow", Attempts: 1, MaxAttempts: 1}, 30*time.Millisecond)
	if err == nil {
		t.Fatal("expected lost lease")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.writes != 0 || dead {
		t.Fatalf("stale worker wrote result/dead callback: %d/%v", q.writes, dead)
	}
}
func TestFastStaleCompletionIsFenced(t *testing.T) {
	q := &leaseDB{owner: 2}
	_, err := execute(context.Background(), q, map[string]Handler{"fast": func(context.Context, Job) error { return nil }}, nil, Job{ID: 1, Type: "fast", Attempts: 1}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if q.writes != 0 {
		t.Fatal("stale completion wrote result")
	}
}
