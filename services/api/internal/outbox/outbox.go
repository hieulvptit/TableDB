// Package outbox: transactional job queue (scan, email, purge, rescan). Same states, backoff and dead-letter as outbox.ts.
package outbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
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
	if batch == 0 {
		batch = 10
	}
	rows, err := q.Query(ctx,
		`UPDATE outbox SET state='running', attempts=attempts+1, locked_until=now() + interval '5 minutes', updated_at=now()
		 WHERE id IN (SELECT id FROM outbox WHERE (state='pending' AND next_run_at <= now()) OR (state='running' AND locked_until < now())
		              ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
		 RETURNING id, type, payload::text, attempts, max_attempts`, batch)
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
	// claimed rows are ordered by id only after the fact; keep Node's ORDER BY id semantics for the batch
	sortJobs(claimed)
	for _, job := range claimed {
		herr := runHandler(ctx, handlers, job)
		if herr == nil {
			if _, err := q.Exec(ctx, "UPDATE outbox SET state='done', last_error=NULL, updated_at=now() WHERE id=$1", job.ID); err != nil {
				return len(claimed), failed, err
			}
			continue
		}
		failed++
		msg := truncate(herr.Error(), 500) // messages come from our own adapters; never payloads/secrets
		if job.Attempts >= job.MaxAttempts {
			if _, err := q.Exec(ctx, "UPDATE outbox SET state='dead', last_error=$2, updated_at=now() WHERE id=$1", job.ID, msg); err != nil {
				return len(claimed), failed, err
			}
			if onDead != nil {
				onDead(ctx, job, herr)
			}
		} else {
			secs := math.Round(BackoffSec(job.Attempts, nil))
			if _, err := q.Exec(ctx, "UPDATE outbox SET state='pending', last_error=$2, next_run_at=now() + make_interval(secs => $3), updated_at=now() WHERE id=$1", job.ID, msg, secs); err != nil {
				return len(claimed), failed, err
			}
		}
	}
	return len(claimed), failed, nil
}

func sortJobs(js []Job) {
	for i := 1; i < len(js); i++ {
		for k := i; k > 0 && js[k].ID < js[k-1].ID; k-- {
			js[k], js[k-1] = js[k-1], js[k]
		}
	}
}

func runHandler(ctx context.Context, handlers map[string]Handler, job Job) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panic: %v", r)
			slog.Error("outbox handler panic", "type", job.Type, "id", job.ID, "panic", fmt.Sprint(r))
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
	go func() {
		defer close(w.done)
		var lastSweep time.Time
		t := time.NewTimer(500 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			if _, _, err := RunOnce(ctx, w.Q, w.Handlers, w.OnDead, 10); err != nil && ctx.Err() == nil {
				slog.Error("worker tick failed", "err", err.Error())
			}
			if w.Sweep != nil && time.Since(lastSweep) > time.Minute {
				lastSweep = time.Now()
				w.Sweep(ctx)
			}
			t.Reset(poll)
		}
	}()
}

// Stop signals the loop and waits for the current tick to finish.
func (w *Worker) Stop() {
	if w.cancel != nil {
		w.cancel()
		<-w.done
	}
}
