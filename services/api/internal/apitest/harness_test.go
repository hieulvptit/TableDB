package apitest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/mail"
	"vnpay/tabledb-api/internal/migrate"
	"vnpay/tabledb-api/internal/outbox"
	"vnpay/tabledb-api/internal/scan"
	"vnpay/tabledb-api/internal/server"
	"vnpay/tabledb-api/internal/shared"
)

// One embedded PostgreSQL per test binary; every test gets its own database cloned from a migrated template (fast + isolated).
var (
	pg      *db.Embedded
	adminDB *db.Pool
	dbSeq   atomic.Int64
)

func TestMain(m *testing.M) {
	code := 1
	defer func() { os.Exit(code) }()
	e, err := db.StartEmbedded("", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "embedded postgres:", err)
		return
	}
	pg = e
	defer e.Stop() //nolint:errcheck
	ctx := context.Background()
	adminDB, err = db.Open(ctx, e.URL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	defer adminDB.Close()
	if _, err := adminDB.Exec(ctx, "CREATE DATABASE tpl"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	tpl, err := db.Open(ctx, e.URLFor("tpl"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	if _, err := migrate.Run(ctx, tpl); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		return
	}
	tpl.Close()
	code = m.Run()
}

// newDB returns a fresh migrated database (own pool, dropped at test end).
func newDB(t testing.TB) *db.Pool {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("t_%d", dbSeq.Add(1))
	if _, err := adminDB.Exec(ctx, "CREATE DATABASE "+name+" TEMPLATE tpl"); err != nil {
		t.Fatal(err)
	}
	p, err := db.Open(ctx, pg.URLFor(name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.Close()
		_, _ = adminDB.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})
	return p
}

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// ---------------------------------------------------------------- fakes

type FakeScanner struct {
	mu     sync.Mutex
	result scan.Result
	calls  int
}

func (f *FakeScanner) Set(r scan.Result) { f.mu.Lock(); f.result = r; f.mu.Unlock() }
func (f *FakeScanner) Scan(_ context.Context, r io.Reader) scan.Result {
	_, rerr := io.Copy(io.Discard, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if rerr != nil {
		return scan.Result{Status: scan.Unavailable, Reason: rerr.Error()}
	}
	return f.result
}

// ---------------------------------------------------------------- harness

type Harness struct {
	T        *testing.T
	Deps     *app.Deps
	DB       *db.Pool
	Srv      *httptest.Server
	Scanner  *FakeScanner
	Mail     *mail.Fake
	Cfg      *config.Config
	handlers map[string]outbox.Handler
}

func harness(t *testing.T, over ...map[string]string) *Harness {
	return harnessWithScanner(t, true, over...)
}

func harnessWithScanner(t *testing.T, fakeScan bool, over ...map[string]string) *Harness {
	t.Helper()
	dir := t.TempDir()
	env := map[string]string{"APP_ENV": "test", "ALLOW_DEV_LOGIN": "1", "BOOTSTRAP_ADMINS": "admin@vnpay.vn", "STORAGE_DIR": filepath.Join(dir, "files"),
		"PART_BYTES": "1024", "PUBLIC_URL": "http://localhost:8080"}
	for _, o := range over {
		for k, v := range o {
			env[k] = v
		}
	}
	cfg, err := config.Load(env)
	if err != nil {
		t.Fatal(err)
	}
	pool := newDB(t)
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	kp, _ := crypto.NewStaticKeyProvider(base64.StdEncoding.EncodeToString(key))
	h := &Harness{T: t, DB: pool, Scanner: &FakeScanner{result: scan.Result{Status: scan.Clean}}, Mail: &mail.Fake{}, Cfg: cfg}
	o := server.Overrides{Mailer: h.Mail, Keys: kp, Log: server.NewLogger(io.Discard, 0)}
	if fakeScan {
		o.Scanner = h.Scanner
	}
	deps, err := server.BuildDeps(cfg, pool, o)
	if err != nil {
		t.Fatal(err)
	}
	h.Deps = deps
	h.handlers = deps.Tickets.Handlers()
	h.Srv = httptest.NewServer(server.Handler(deps))
	t.Cleanup(h.Srv.Close)
	return h
}

// Work runs the outbox worker synchronously (all pending jobs are made due first).
func (h *Harness) Work(times ...int) {
	h.T.Helper()
	n := 3
	if len(times) > 0 {
		n = times[0]
	}
	ctx := context.Background()
	for i := 0; i < n; i++ {
		h.Exec("UPDATE outbox SET next_run_at = now() WHERE state='pending'")
		if _, _, err := outbox.RunOnce(ctx, h.DB, h.handlers, h.Deps.Tickets.OnDead, 0); err != nil {
			h.T.Fatal(err)
		}
	}
}

func (h *Harness) Exec(sql string, args ...any) {
	h.T.Helper()
	if _, err := h.DB.Exec(context.Background(), sql, args...); err != nil {
		h.T.Fatalf("%s: %v", sql, err)
	}
}

// Scalar runs a query returning one value.
func Scalar[T any](h *Harness, sql string, args ...any) T {
	h.T.Helper()
	var v T
	if err := h.DB.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		h.T.Fatalf("%s: %v", sql, err)
	}
	return v
}

// ---------------------------------------------------------------- HTTP client

type Resp struct {
	Status int
	Body   []byte
	Header http.Header
	json   any
}

// JSON returns the decoded body (nil when not JSON).
func (r *Resp) JSON() any {
	if r.json == nil {
		_ = json.Unmarshal(r.Body, &r.json)
	}
	return r.json
}

// Get reads a dotted path ("ticket.status", "leaders.0.email") from the JSON body.
func (r *Resp) Get(path string) any { return jpath(r.JSON(), path) }
func (r *Resp) Str(path string) string {
	s, _ := r.Get(path).(string)
	return s
}
func (r *Resp) Bool(path string) bool { b, _ := r.Get(path).(bool); return b }
func (r *Resp) Num(path string) float64 {
	f, _ := r.Get(path).(float64)
	return f
}
func (r *Resp) Code() string { return r.Str("error.code") }

func jpath(v any, path string) any {
	if path == "" {
		return v
	}
	for _, k := range strings.Split(path, ".") {
		switch x := v.(type) {
		case map[string]any:
			v = x[k]
		case []any:
			var i int
			if _, err := fmt.Sscanf(k, "%d", &i); err != nil || i < 0 || i >= len(x) {
				return nil
			}
			v = x[i]
		default:
			return nil
		}
	}
	return v
}

type Client struct {
	h      *Harness
	Email  string
	ID     string
	CSRF   string
	Cookie string // "name=value"
	Bearer string
	Kind   string
	Desk   *Client // web clients: the same user's desktop (bearer) session
}

type Opt struct {
	Body    any
	Raw     []byte
	Headers map[string]string
	NoAuth  bool
}

func (c *Client) Req(method, path string, o ...Opt) *Resp {
	c.h.T.Helper()
	return c.h.do(c, method, path, firstOpt(o))
}

func firstOpt(o []Opt) Opt {
	if len(o) > 0 {
		return o[0]
	}
	return Opt{}
}

func (h *Harness) do(c *Client, method, path string, o Opt) *Resp {
	h.T.Helper()
	var rd io.Reader
	hdr := map[string]string{}
	switch {
	case o.Raw != nil:
		rd = bytes.NewReader(o.Raw)
		hdr["Content-Type"] = "application/octet-stream"
	case o.Body != nil:
		var b []byte
		if s, ok := o.Body.(string); ok {
			b = []byte(s)
		} else {
			b, _ = json.Marshal(o.Body)
		}
		rd = bytes.NewReader(b)
		hdr["Content-Type"] = "application/json"
	}
	if c != nil && !o.NoAuth {
		if c.Bearer != "" {
			hdr["Authorization"] = "Bearer " + c.Bearer
		} else {
			hdr["Cookie"] = c.Cookie
			if method != "GET" {
				hdr["X-CSRF-Token"] = c.CSRF
			}
		}
	}
	for k, v := range o.Headers {
		hdr[k] = v
	}
	url := path
	if strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/healthz") && !strings.HasPrefix(path, "/readyz") {
		url = "/api/v1" + path
	}
	req, err := http.NewRequest(method, h.Srv.URL+url, rd)
	if err != nil {
		h.T.Fatal(err)
	}
	for k, v := range hdr {
		if k == "Cookie" && v == "" {
			continue
		}
		req.Header.Set(k, v)
	}
	cl := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 60 * time.Second}
	res, err := cl.Do(req)
	if err != nil {
		h.T.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return &Resp{Status: res.StatusCode, Body: b, Header: res.Header}
}

// Anon is an unauthenticated request (optionally with custom headers).
func (h *Harness) Anon(method, path string, o ...Opt) *Resp {
	h.T.Helper()
	oo := firstOpt(o)
	oo.NoAuth = true
	return h.do(nil, method, path, oo)
}

func (c *Client) Get(p string) *Resp { c.h.T.Helper(); return c.Req("GET", p) }
func (c *Client) Post(p string, body any, headers ...map[string]string) *Resp {
	c.h.T.Helper()
	if body == nil {
		body = map[string]any{}
	}
	o := Opt{Body: body}
	if len(headers) > 0 {
		o.Headers = headers[0]
	}
	return c.Req("POST", p, o)
}
func (c *Client) Put(p string, body any) *Resp {
	c.h.T.Helper()
	return c.Req("PUT", p, Opt{Body: body})
}
func (c *Client) Del(p string) *Resp { c.h.T.Helper(); return c.Req("DELETE", p) }

// User signs in through the dev-login route and also mints a desktop (bearer) session for the same account.
func (h *Harness) User(email string) *Client {
	h.T.Helper()
	r := h.Anon("POST", "/auth/dev-login", Opt{Body: map[string]any{"email": email, "name": strings.Split(email, "@")[0]}})
	if r.Status != 200 {
		h.T.Fatalf("dev-login failed: %d %s", r.Status, r.Body)
	}
	sc := r.Header.Get("Set-Cookie")
	c := &Client{h: h, Email: email, CSRF: r.Str("csrfToken"), Cookie: strings.SplitN(sc, ";", 2)[0], Kind: "web"}
	c.ID = c.Get("/auth/me").Str("user.id")
	s, err := auth.CreateSession(context.Background(), h.DB, auth.NewSession{UserID: c.ID, Kind: shared.ClientDesktop, AuthTime: time.Now(), WithRefresh: true})
	if err != nil {
		h.T.Fatal(err)
	}
	c.Desk = &Client{h: h, Email: email, ID: c.ID, Bearer: s.ID, Kind: "desktop"}
	return c
}

type Seed struct{ Admin, Alice, Lead, Lead2, Bob *Client }

func (h *Harness) SeedTransfer() *Seed {
	s := &Seed{Admin: h.User("admin@vnpay.vn"), Alice: h.User("alice@vnpay.vn"), Lead: h.User("lead@vnpay.vn"), Lead2: h.User("lead2@vnpay.vn"), Bob: h.User("bob@vnpay.vn")}
	h.AddLeader(s.Lead.ID)
	h.AddLeader(s.Lead2.ID)
	return s
}

func (h *Harness) AddLeader(id string) {
	h.Exec("INSERT INTO leaders (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET enabled=true", id)
	h.Exec("INSERT INTO role_assignments (user_id, role) VALUES ($1,'leader') ON CONFLICT DO NOTHING", id)
}

type UserSet struct {
	Roles  []string
	Grants []string
	Active *bool
}

func (h *Harness) SetUser(id string, o UserSet) {
	h.Exec("DELETE FROM role_assignments WHERE user_id=$1", id)
	for _, r := range o.Roles {
		h.Exec("INSERT INTO role_assignments (user_id, role) VALUES ($1,$2)", id, r)
	}
	h.Exec("DELETE FROM user_grants WHERE user_id=$1", id)
	for _, g := range o.Grants {
		h.Exec("INSERT INTO user_grants (user_id, permission) VALUES ($1,$2)", id, g)
	}
	if o.Active != nil {
		h.Exec("UPDATE users SET active=$2 WHERE id=$1", id, *o.Active)
	}
}

func (h *Harness) AddTarget(name, driver, host string, port int, database *string, allowWrite bool, authModes []string, proxy any) string {
	if authModes == nil {
		authModes = []string{"password"}
	}
	var p *string
	if proxy != nil {
		b, _ := json.Marshal(proxy)
		s := string(b)
		p = &s
	}
	return Scalar[string](h, `INSERT INTO db_targets (name, driver, host, port, database, allow_write, auth_modes, proxy) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id::text`,
		name, driver, host, port, database, allowWrite, authModes, p)
}

type Upload struct {
	ApproverID   string
	Content      []byte
	Name         string
	RecipientIDs []string
	NoComplete   bool
	ViaWeb       bool
}

type Uploaded struct {
	Ticket     map[string]any
	TicketID   string
	Code       string
	PartBytes  int
	TotalParts int
}

func (h *Harness) Randbytes(n int) []byte { b := make([]byte, n); _, _ = rand.Read(b); return b }

// UploadFile uploads from the desktop (jump → office, the original flow) unless ViaWeb (office → jump).
func (h *Harness) UploadFile(who *Client, o Upload) Uploaded {
	h.T.Helper()
	c := who.Desk
	if o.ViaWeb {
		c = who
	}
	name := o.Name
	if name == "" {
		name = "data.zip"
	}
	rec := o.RecipientIDs
	if rec == nil {
		rec = []string{}
	}
	created := c.Post("/transfers", map[string]any{"fileName": name, "size": len(o.Content), "sha256": sha(o.Content), "purpose": "Chuyển dữ liệu đối soát", "approverId": o.ApproverID, "recipientIds": rec})
	h.ExpectOK(created)
	u := Uploaded{Ticket: created.Get("ticket").(map[string]any), PartBytes: int(created.Num("partBytes")), TotalParts: int(created.Num("totalParts"))}
	u.TicketID, u.Code = u.Ticket["id"].(string), u.Ticket["code"].(string)
	for n := 1; n <= u.TotalParts; n++ {
		end := n * u.PartBytes
		if end > len(o.Content) {
			end = len(o.Content)
		}
		part := o.Content[(n-1)*u.PartBytes : end]
		h.ExpectOK(c.Req("PUT", fmt.Sprintf("/transfers/%s/parts/%d", u.TicketID, n), Opt{Raw: part, Headers: map[string]string{"X-Part-SHA256": sha(part)}}))
	}
	if o.NoComplete {
		return u
	}
	done := c.Post("/transfers/"+u.TicketID+"/complete", nil, map[string]string{"Idempotency-Key": "idem-" + u.TicketID})
	h.ExpectOK(done)
	u.Ticket = done.Get("ticket").(map[string]any)
	return u
}

func (h *Harness) ExpectOK(r *Resp) {
	h.T.Helper()
	if r.Status >= 400 {
		h.T.Fatalf("HTTP %d: %s", r.Status, r.Body)
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func timeNow() time.Time { return time.Now() }

func ctxBG() context.Context { return context.Background() }
