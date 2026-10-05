package apitest

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/outbox"
	"vnpay/tabledb-api/internal/server"
)

func TestOutboxDedupeAndConcurrency(t *testing.T) {
	p := newDB(t)
	ctx := context.Background()
	if err := outbox.Enqueue(ctx, p, "t", map[string]any{"n": 1}, outbox.EnqueueOpts{DedupeKey: "d1"}); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Enqueue(ctx, p, "t", map[string]any{"n": 1}, outbox.EnqueueOpts{DedupeKey: "d1"}); err != nil { // deduped
		t.Fatal(err)
	}
	var n int
	_ = p.QueryRow(ctx, "SELECT count(*)::int FROM outbox").Scan(&n)
	eq(t, n, 1, "rows after dedupe")

	var runs atomic.Int32
	h := map[string]outbox.Handler{"t": func(context.Context, outbox.Job) error { runs.Add(1); return nil }}
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, _, err := outbox.RunOnce(ctx, p, h, nil, 10)
			if err != nil {
				t.Error(err)
			}
			done <- struct{}{}
		}()
	}
	<-done
	<-done
	eq(t, int(runs.Load()), 1, "concurrent workers run a job once")

	// a crashed worker (expired lock) is re-claimed
	if _, err := p.Exec(ctx, "INSERT INTO outbox (type, payload, state, locked_until) VALUES ('t','{}','running', now() - interval '1 minute')"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := outbox.RunOnce(ctx, p, h, nil, 10); err != nil {
		t.Fatal(err)
	}
	eq(t, int(runs.Load()), 2, "expired lock re-claimed")
}

func TestOutboxRetryAndDeadLetter(t *testing.T) {
	p := newDB(t)
	ctx := context.Background()
	_ = outbox.Enqueue(ctx, p, "boom", map[string]any{"ticketId": "x"}, outbox.EnqueueOpts{DedupeKey: "b", MaxAttempts: 2})
	_ = outbox.Enqueue(ctx, p, "unknown", map[string]any{}, outbox.EnqueueOpts{DedupeKey: "u", MaxAttempts: 1})
	var dead []string
	h := map[string]outbox.Handler{"boom": func(context.Context, outbox.Job) error { panic("kaboom") }}
	onDead := func(_ context.Context, j outbox.Job, _ error) { dead = append(dead, j.Type) }
	ran, failed, err := outbox.RunOnce(ctx, p, h, onDead, 10)
	if err != nil || ran != 2 || failed != 2 {
		t.Fatalf("%d %d %v", ran, failed, err)
	}
	var state, lastErr string
	var attempts int
	_ = p.QueryRow(ctx, "SELECT state, attempts, last_error FROM outbox WHERE type='boom'").Scan(&state, &attempts, &lastErr)
	if state != "pending" || attempts != 1 || !strings.Contains(lastErr, "panic") {
		t.Fatalf("after 1st failure: %s %d %s", state, attempts, lastErr)
	}
	var secs float64
	_ = p.QueryRow(ctx, "SELECT extract(epoch from next_run_at - now())::float8 FROM outbox WHERE type='boom'").Scan(&secs)
	if secs < 2 || secs > 8 { // 5s ±25%
		t.Fatalf("backoff %.1fs", secs)
	}
	_ = p.QueryRow(ctx, "SELECT state FROM outbox WHERE type='unknown'").Scan(&state)
	eq(t, state, "dead", "no handler => dead after max attempts")
	_, _ = p.Exec(ctx, "UPDATE outbox SET next_run_at=now() WHERE type='boom'")
	_, _, _ = outbox.RunOnce(ctx, p, h, onDead, 10)
	_ = p.QueryRow(ctx, "SELECT state FROM outbox WHERE type='boom'").Scan(&state)
	eq(t, state, "dead", "dead after max attempts")
	eq(t, len(dead), 2, "onDead callbacks")
}

func TestBackoff(t *testing.T) {
	fixed := func(v float64) func() float64 { return func() float64 { return v } }
	eq(t, outbox.BackoffSec(1, fixed(0.5)), 5.0, "attempt 1")
	eq(t, outbox.BackoffSec(4, fixed(0.5)), 40.0, "attempt 4")
	eq(t, outbox.BackoffSec(20, fixed(0.5)), 3600.0, "capped")
	if !(outbox.BackoffSec(3, fixed(0)) < outbox.BackoffSec(3, fixed(1))) {
		t.Fatal("jitter")
	}
}

func TestWorkerLoop(t *testing.T) {
	x := newT(t)
	up := x.UploadFile(x.S.Alice, Upload{ApproverID: x.S.Lead.ID, Content: x.content()})
	w := server.NewWorker(x.Deps)
	w.PollEvery = 50 * time.Millisecond
	w.Start(context.Background())
	defer w.Stop()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if x.status(x.S.Alice, up.TicketID)["status"] == "PENDING_APPROVAL" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("background worker did not move the ticket to PENDING_APPROVAL")
}

func TestSeedLeaders(t *testing.T) {
	h := harness(t)
	ctx := context.Background()
	if err := server.SeedLeaders(ctx, h.Cfg, h.DB, "leader1@vnpay.vn:A,leader2@vnpay.vn:Tên: B"); err != nil {
		t.Fatal(err)
	}
	if err := server.SeedLeaders(ctx, h.Cfg, h.DB, "leader1@vnpay.vn:A2"); err != nil { // idempotent
		t.Fatal(err)
	}
	eq(t, Scalar[int](h, "SELECT count(*)::int FROM leaders"), 2, "leaders")
	eq(t, Scalar[string](h, "SELECT name FROM users WHERE email='leader2@vnpay.vn'"), "Tên: B", "name with colon")
	eq(t, Scalar[string](h, "SELECT name FROM users WHERE email='leader1@vnpay.vn'"), "A2", "name updated")
	alice := h.User("alice@vnpay.vn")
	r := alice.Get("/transfers/options")
	eq(t, len(r.Get("leaders").([]any)), 2, "options leaders")
	// seeding an account that already exists under another provider reuses it
	h.User("dev@vnpay.vn")
	if err := server.SeedLeaders(ctx, h.Cfg, h.DB, "dev@vnpay.vn"); err != nil {
		t.Fatal(err)
	}
	eq(t, Scalar[int](h, "SELECT count(*)::int FROM role_assignments WHERE role='leader'"), 3, "leader roles")
	// prod refuses
	prod := *h.Cfg
	prod.Env = "prod"
	if err := server.SeedLeaders(ctx, &prod, h.DB, "x@vnpay.vn"); err == nil {
		t.Fatal("prod must refuse DEV_SEED_LEADERS")
	}
}

func TestUnverifiedEmailNeverLinksAccounts(t *testing.T) {
	h := harness(t)
	victim := h.User("victim@vnpay.vn")
	_ = victim
	ctx := context.Background()
	_, err := auth.UpsertUser(ctx, h.DB, h.Cfg, auth.Claims{Provider: "other-idp", Sub: "attacker", Email: "victim@vnpay.vn", EmailVerified: false, Name: "x"})
	if err == nil || !strings.Contains(err.Error(), "FORBIDDEN") {
		t.Fatalf("unverified email must not take over an existing account: %v", err)
	}
	if _, err := auth.UpsertUser(ctx, h.DB, h.Cfg, auth.Claims{Provider: "other-idp", Sub: "legit", Email: "victim@vnpay.vn", EmailVerified: true, Name: "x"}); err != nil {
		t.Fatal(err)
	}
	// bootstrap admin only with a verified email
	if _, err := auth.UpsertUser(ctx, h.DB, h.Cfg, auth.Claims{Provider: "idp", Sub: "a1", Email: "admin@vnpay.vn", EmailVerified: false, Name: "a"}); err != nil {
		t.Fatal(err)
	}
	eq(t, Scalar[int](h, "SELECT count(*)::int FROM role_assignments ra JOIN users u ON u.id=ra.user_id WHERE u.email='admin@vnpay.vn' AND ra.role='admin'"), 0, "admin from unverified email")
	if _, err := auth.UpsertUser(ctx, h.DB, h.Cfg, auth.Claims{Provider: "idp", Sub: "a1", Email: "admin@vnpay.vn", EmailVerified: true, Name: "a"}); err != nil {
		t.Fatal(err)
	}
	eq(t, Scalar[int](h, "SELECT count(*)::int FROM role_assignments ra JOIN users u ON u.id=ra.user_id WHERE u.email='admin@vnpay.vn' AND ra.role='admin'"), 1, "admin from verified email")
}

func TestGlobalRateLimit(t *testing.T) {
	h := harness(t)
	limited := 0
	for i := 0; i < 310; i++ {
		if h.Anon("GET", "/healthz").Status == 429 {
			limited++
		}
	}
	if limited != 10 {
		t.Fatalf("expected the 301st..310th hits to be limited (300/min default), got %d", limited)
	}
	r := h.Anon("GET", "/healthz")
	eq(t, r.Code(), "RATE_LIMITED", "code")
	if r.Header.Get("Retry-After") == "" {
		t.Fatal("Retry-After")
	}
}

func TestSecurityHeadersHTTPS(t *testing.T) {
	h := harness(t, map[string]string{"PUBLIC_URL": "https://bo.example.vn"})
	r := h.Anon("GET", "/healthz")
	eq(t, r.Header.Get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains", "HSTS")
	// https PUBLIC_URL => __Host- cookie, Secure
	login := h.Anon("POST", "/auth/dev-login", Opt{Body: map[string]any{"email": "a@vnpay.vn"}})
	sc := login.Header.Get("Set-Cookie")
	if !strings.HasPrefix(sc, "__Host-sid=") || !strings.Contains(sc, "Secure") || !strings.Contains(sc, "HttpOnly") || !strings.Contains(sc, "SameSite=Lax") || !strings.Contains(sc, "Path=/") || strings.Contains(sc, "Domain") {
		t.Fatalf("cookie: %s", sc)
	}
}

func TestTrustProxyClientIP(t *testing.T) {
	h := harness(t, map[string]string{"TRUST_PROXY": "1"})
	alice := h.User("alice@vnpay.vn")
	alice.Req("GET", "/auth/me", Opt{Headers: map[string]string{"X-Forwarded-For": "203.0.113.9, 10.0.0.1"}})
	status(t, alice.Post("/auth/logout", nil, map[string]string{"X-Forwarded-For": "203.0.113.9, 10.0.0.1"}), 200, "logout")
	eq(t, Scalar[string](h, "SELECT ip FROM audit_log WHERE action='auth.logout'"), "203.0.113.9", "audited ip")
	h2 := harness(t)
	b := h2.User("bob@vnpay.vn")
	b.Post("/auth/logout", nil, map[string]string{"X-Forwarded-For": "203.0.113.9"})
	eq(t, Scalar[string](h2, "SELECT ip FROM audit_log WHERE action='auth.logout'"), "127.0.0.1", "XFF ignored without TRUST_PROXY")
}
