// Package outbox: transactional job queue (scan, email, purge, rescan). Same states, backoff and dead-letter as outbox.ts.
package outbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"runtime/debug"
	"sync"
	"time"
	"unicode/utf8"

	"vnpay/tabledb-api/internal/db"
)

type Job struct {
	ID          int64
	Type        string
	Payload     json.RawMessage
	Attempts    int
	MaxAttempts int
}

// PayloadString reads a string field from the JSON payload ("" if absent).
func (j Job) PayloadString(key string) string {
	var m map[string]any
	_ = json.Unmarshal(j.Payload, &m)
	s, _ := m[key].(string)
	return s
}

type Handler func(ctx context.Context, job Job) error
type DeadHandler func(ctx context.Context, job Job, err error)

type EnqueueOpts struct {
	DedupeKey   string
	DelaySec    float64
	MaxAttempts int // 0 => 8
}

// Enqueue inserts a job; a repeated DedupeKey is silently ignored.
func Enqueue(ctx context.Context, q db.Querier, typ string, payload any, o EnqueueOpts) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var dedupe *string
	if o.DedupeKey != "" {
		dedupe = &o.DedupeKey
	}
	max := o.MaxAttempts
	if max == 0 {
		max = 8
	}
	_, err = q.Exec(ctx,
		`INSERT INTO outbox (type, payload, dedupe_key, next_run_at, max_attempts) VALUES ($1,$2::jsonb,$3, now() + make_interval(secs => $4), $5)
		 ON CONFLICT (dedupe_key) DO NOTHING`, typ, string(b), dedupe, o.DelaySec, max)
	return err
}

// BackoffSec: min(3600, 5·2^(attempt-1)) with ±25% jitter. rnd returns [0,1).
func BackoffSec(attempt int, rnd func() float64) float64 {
	if rnd == nil {
		rnd = rand.Float64
	}
	return math.Min(3600, 5*math.Pow(2, float64(attempt-1))) * (0.75 + rnd()*0.5)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// RunOnce claims due jobs (crash-safe: running jobs whose lock expired are re-claimed), runs handlers, applies retry/dead-letter.
func RunOnce(ctx context.Context, q db.Querier, handlers map[string]Handler, onDead DeadHandler, batch int) (ran, failed int, err error) {
	return runOnce(ctx, q, handlers, onDead, batch, 5*time.Minute, nil, false)
}

func runOnce(ctx context.Context, q db.Querier, handlers map[string]Handler, onDead DeadHandler, batch int, lease time.Duration, types []string, exclude bool) (ran, failed int, err error) {
	if batch <= 0 {
		batch = 10
	}
	// Every claimed job gets an execution slot immediately; never preclaim a
	// larger batch and leave its leases expiring behind long-running handlers.
	if batch > 10 {
		batch = 10
	}
	rows, err := q.Query(ctx,
		`UPDATE outbox SET state='running', attempts=attempts+1, locked_until=now() + make_interval(secs => $2), updated_at=now()
		 WHERE id IN (SELECT id FROM outbox WHERE ((state='pending' AND next_run_at <= now()) OR (state='running' AND locked_until < now()))
 AND ($3::text[] IS NULL OR (type=ANY($3::text[])) <> $4)
		              ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
		 RETURNING id, type, payload::text, attempts, max_attempts`, batch, lease.Seconds(), types, exclude)
	if err != nil {
		return 0, 0, err
	}
	var claimed []Job
	for rows.Next() {
		var j Job
		var p string
		if err := rows.Scan(&j.ID, &j.Type, &p, &j.Attempts, &j.MaxAttempts); err != nil {
			rows.Close()
			return 0, 0, err
		}
		j.Payload = json.RawMessage(p)
		claimed = append(claimed, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, job := range claimed {
		wg.Add(1)
		go func(job Job) {
			defer wg.Done()
			didFail, jobErr := execute(ctx, q, handlers, onDead, job, lease)
			mu.Lock()
			defer mu.Unlock()
			if didFail {
				failed++
			}
			if err == nil {
				err = jobErr
			}
		}(job)
	}
	wg.Wait()
	return len(claimed), failed, err
}

// Attempts increments atomically on claim and acts as the ownership generation:
// a reclaimed job cannot be acknowledged or renewed by its previous worker.
func execute(ctx context.Context, q db.Querier, handlers map[string]Handler, onDead DeadHandler, job Job, lease time.Duration) (bool, error) {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	heartbeatDone := make(chan error, 1)
	go func() {
		tick := time.NewTicker(lease / 3)
		defer tick.Stop()
		for {
			select {
			case <-done:
				heartbeatDone <- nil
				return
			case <-jobCtx.Done():
				heartbeatDone <- jobCtx.Err()
				return
			case <-tick.C:
				renewCtx, renewCancel := context.WithTimeout(jobCtx, lease/3)
				tag, err := q.Exec(renewCtx, `UPDATE outbox SET locked_until=now() + make_interval(secs => $3)
     WHERE id=$1 AND attempts=$2 AND state='running' AND locked_until > now()`, job.ID, job.Attempts, lease.Seconds())
				renewCancel()
				if err == nil && tag.RowsAffected() == 0 {
					err = fmt.Errorf("job %d lease lost", job.ID)
				}
				if err != nil {
					cancel()
					heartbeatDone <- err
					return
				}
			}
		}
	}()
	herr := runHandler(jobCtx, handlers, job)
	close(done)
	if leaseErr := <-heartbeatDone; leaseErr != nil {
		return false, leaseErr
	}
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	// All result writes fence by generation and lease. Losing ownership leaves
	// recovery to the current owner, even if an adapter ignored cancellation.
	const owned = " WHERE id=$1 AND attempts=$2 AND state='running' AND locked_until > now()"
	if herr == nil {
		_, err := q.Exec(ctx, "UPDATE outbox SET state='done', last_error=NULL, updated_at=now()"+owned, job.ID, job.Attempts)
		return false, err
	}
	msg := truncate(herr.Error(), 500)
	if job.Attempts >= job.MaxAttempts {
		tag, err := q.Exec(ctx, "UPDATE outbox SET state='dead', last_error=$3, updated_at=now()"+owned, job.ID, job.Attempts, msg)
		if err == nil && tag.RowsAffected() == 1 && onDead != nil {
			onDead(ctx, job, herr)
		}
		if err == nil && tag.RowsAffected() == 1 {
			slog.ErrorContext(ctx, "outbox job exhausted retries", "job_id", job.ID, "job_type", job.Type,
				"attempt", job.Attempts, "max_attempts", job.MaxAttempts, "error", herr)
		}
		return true, err
	}
	secs := math.Round(BackoffSec(job.Attempts, nil))
	tag, err := q.Exec(ctx, "UPDATE outbox SET state='pending', last_error=$3, next_run_at=now() + make_interval(secs => $4), updated_at=now()"+owned, job.ID, job.Attempts, msg, secs)
	if err == nil && tag.RowsAffected() == 1 {
		slog.WarnContext(ctx, "outbox job retry scheduled", "job_id", job.ID, "job_type", job.Type,
			"attempt", job.Attempts, "max_attempts", job.MaxAttempts, "retry_in_sec", secs, "error", herr)
	}
	return true, err
}

func runHandler(ctx context.Context, handlers map[string]Handler, job Job) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panic: %v", r)
			slog.ErrorContext(ctx, "outbox handler panic", "job_type", job.Type, "job_id", job.ID, "panic", fmt.Sprint(r), "panic_stack", string(debug.Stack()))
		}
	}()
	h, ok := handlers[job.Type]
	if !ok {
		return fmt.Errorf("no handler for %s", job.Type)
	}
	return h(ctx, job)
}

// Worker polls RunOnce and the periodic sweep until stopped.
type Worker struct {
	Q         db.Querier
	Handlers  map[string]Handler
	OnDead    DeadHandler
	Sweep     func(ctx context.Context) // called at most once a minute
	PollEvery time.Duration

	cancel context.CancelFunc
	done   chan struct{}
}

func (w *Worker) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel
	w.done = make(chan struct{})
	poll := w.PollEvery
	if poll == 0 {
		poll = 2 * time.Second
	}
	// Independent lanes reserve capacity for notifications and cleanup even
	// when every scan is slow. Each slot claims one job just before executing it.
	lanes := []struct {
		types   []string
		slots   int
		exclude bool
	}{
		{[]string{"scan", "rescan"}, 2, false},
		{[]string{"email.approval", "email.decision", "email.quarantine"}, 4, false},
		{[]string{"purge"}, 2, false},
		{[]string{"scan", "rescan", "email.approval", "email.decision", "email.quarantine", "purge"}, 1, true},
	}
	var workers sync.WaitGroup
	for _, lane := range lanes {
		for i := 0; i < lane.slots; i++ {
			workers.Add(1)
			go func(types []string, exclude bool) {
				defer workers.Done()
				timer := time.NewTimer(500 * time.Millisecond)
				defer timer.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-timer.C:
					}
					ran, _, err := runOnce(ctx, w.Q, w.Handlers, w.OnDead, 1, 5*time.Minute, types, exclude)
					if err != nil && ctx.Err() == nil {
						slog.Error("worker tick failed", "err", err.Error())
					}
					delay := poll
					if ran > 0 && err == nil {
						delay = 0
					}
					timer.Reset(delay)
				}
			}(lane.types, lane.exclude)
		}
	}
	if w.Sweep != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			timer := time.NewTimer(500 * time.Millisecond)
			defer timer.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-timer.C:
				}
				w.Sweep(ctx)
				timer.Reset(time.Minute)
			}
		}()
	}
	go func() { workers.Wait(); close(w.done) }()
}

// Stop signals the loop and waits for the current tick to finish.
func (w *Worker) Stop() {
	if w.cancel != nil {
		w.cancel()
		<-w.done
	}
}
