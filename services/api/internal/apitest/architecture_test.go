package apitest

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/outbox"
)

func TestTransactionPanicReleasesConnectionAndLock(t *testing.T) {
	p := newDB(t)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic")
			}
		}()
		_ = p.InTx(context.Background(), func(tx db.Runner) error {
			if _, err := tx.Exec(context.Background(), "SELECT pg_advisory_xact_lock(1234567)"); err != nil {
				t.Fatal(err)
			}
			panic("callback failed")
		})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := p.InTx(ctx, func(tx db.Runner) error { _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(1234567)"); return err }); err != nil {
		t.Fatal(err)
	}
	if n := p.P.Stat().AcquiredConns(); n != 0 {
		t.Fatalf("leaked connections: %d", n)
	}
}

func TestConcurrentPartPublicationKeepsWinningMetadata(t *testing.T) {
	x := newT(t)
	original := x.Randbytes(1024)
	other := append([]byte(nil), original...)
	other[0] ^= 0xff
	created := x.S.Alice.Post("/transfers", map[string]any{"fileName": "r.zip", "size": len(original), "sha256": sha(original), "purpose": "concurrent upload regression", "approverId": x.S.Lead.ID})
	x.ExpectOK(created)
	id := created.Str("ticket.id")
	start := make(chan struct{})
	results := make(chan *Resp, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			b := original
			if i%2 == 1 {
				b = other
			}
			results <- x.S.Alice.Req("PUT", "/transfers/"+id+"/parts/1", Opt{Raw: b, Headers: map[string]string{"X-Part-SHA256": sha(b)}})
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	ok, conflict := 0, 0
	for r := range results {
		switch r.Status {
		case 200:
			ok++
		case 409:
			conflict++
		default:
			t.Fatalf("unexpected response %d: %s", r.Status, r.Body)
		}
	}
	if ok != 8 || conflict != 8 {
		t.Fatalf("success/conflicts=%d/%d", ok, conflict)
	}
	var metadata string
	var wrapped string
	if err := x.DB.QueryRow(context.Background(), "SELECT p.sha256,t.dek_wrapped FROM upload_parts p JOIN tickets t ON t.id=p.ticket_id WHERE t.id=$1", id).Scan(&metadata, &wrapped); err != nil {
		t.Fatal(err)
	}
	ct, err := x.Deps.Store.Get(id + "/1")
	if err != nil {
		t.Fatal(err)
	}
	dek, err := x.Deps.Keys.Unwrap(wrapped)
	if err != nil {
		t.Fatal(err)
	}
	pt, err := crypto.OpenBuffer(dek, ct, []byte("part:"+id+":1"))
	if err != nil {
		t.Fatal(err)
	}
	if sha(pt) != metadata {
		t.Fatal("ciphertext does not match winning metadata")
	}
}

func TestOutboxStartsWholeClaimWithoutHeadOfLineBlocking(t *testing.T) {
	p := newDB(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := outbox.Enqueue(ctx, p, "slow", nil, outbox.EnqueueOpts{}); err != nil {
			t.Fatal(err)
		}
	}
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, _, err := outbox.RunOnce(ctx, p, map[string]outbox.Handler{"slow": func(context.Context, outbox.Job) error { started <- struct{}{}; <-release; return nil }}, nil, 2)
		done <- err
	}()
	defer close(release)
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("second handler blocked behind first")
		}
	}
	// Simulate another replica reclaiming while the old handler is still running.
	if _, err := p.Exec(ctx, "UPDATE outbox SET attempts=attempts+1,state='pending' WHERE id=(SELECT min(id) FROM outbox)"); err != nil {
		t.Fatal(err)
	}
	release <- struct{}{}
	release <- struct{}{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var state string
	if err := p.QueryRow(ctx, "SELECT state FROM outbox ORDER BY id LIMIT 1").Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending" {
		t.Fatal(fmt.Sprintf("stale worker acknowledged reclaimed job: %s", state))
	}
}

func TestWorkerReservesMailCapacityDuringSlowScans(t *testing.T) {
	p := newDB(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := outbox.Enqueue(ctx, p, "scan", nil, outbox.EnqueueOpts{}); err != nil {
			t.Fatal(err)
		}
	}
	scanStarted := make(chan struct{}, 3)
	release := make(chan struct{})
	mailDone := make(chan struct{}, 1)
	worker := outbox.Worker{Q: p, PollEvery: 10 * time.Millisecond, Handlers: map[string]outbox.Handler{
		"scan": func(ctx context.Context, _ outbox.Job) error {
			scanStarted <- struct{}{}
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
		"email.approval": func(context.Context, outbox.Job) error { mailDone <- struct{}{}; return nil },
	}}
	worker.Start(ctx)
	defer worker.Stop()
	defer close(release)
	for i := 0; i < 2; i++ {
		select {
		case <-scanStarted:
		case <-time.After(2 * time.Second):
			t.Fatal("scan slots did not start")
		}
	}
	if err := outbox.Enqueue(ctx, p, "email.approval", nil, outbox.EnqueueOpts{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-mailDone:
	case <-time.After(2 * time.Second):
		t.Fatal("mail blocked behind scans")
	}
	select {
	case <-scanStarted:
		t.Fatal("scan concurrency exceeded reserved slots")
	default:
	}
}
