package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/inspect"
	"vnpay/tabledb-api/internal/reqmeta"
	"vnpay/tabledb-api/internal/securetransport"
	"vnpay/tabledb-api/internal/shared"
)

// ---- JSON / errors

// WriteJSON writes a JSON body with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		WriteError(w, nil, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
}

type errBody struct {
	Error struct {
		Code    apperr.Code `json:"code"`
		Message string      `json:"message"`
		Details any         `json:"details,omitempty"`
	} `json:"error"`
}

func errorResponse(code apperr.Code, msg string, details any) errBody {
	var b errBody
	b.Error.Code, b.Error.Message, b.Error.Details = code, msg, details
	return b
}

// WriteError maps any error to the API error body, exactly like the Node error handler.
func WriteError(w http.ResponseWriter, log *slog.Logger, err error) {
	var ae *apperr.Error
	var ve *shared.ValidationError
	var mbe *http.MaxBytesError
	switch {
	case errors.As(err, &ae):
		if ae.Code == apperr.StepupRequired {
			w.Header().Set("X-Stepup", "required")
		}
		WriteJSON(w, ae.Status(), errorResponse(ae.Code, ae.Message, ae.Details))
	case errors.As(err, &ve):
		WriteJSON(w, 400, errorResponse(apperr.ValidationCode, "invalid request", ve.Issues))
	case errors.As(err, &mbe):
		WriteJSON(w, 400, errorResponse(apperr.ValidationCode, "payload too large", nil))
	default:
		if log != nil {
			log.Error("unhandled", "err", err.Error())
		}
		WriteJSON(w, 500, errorResponse(apperr.Internal, "internal error", nil))
	}
}

// ReadBody reads the request body bounded by limit (exceeding it yields 400 VALIDATION "payload too large").
func ReadBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, apperr.Validation("payload too large")
		}
		return nil, apperr.Validation("could not read request body")
	}
	return b, nil
}

const JSONBodyLimit = 2 * 1024 * 1024

// ---- auth

type ctxKey int

const authKey ctxKey = 1

// AuthOf returns the authenticated caller or UNAUTHENTICATED.
func AuthOf(r *http.Request) (*auth.Ctx, error) {
	a, _ := r.Context().Value(authKey).(*auth.Ctx)
	if a == nil {
		return nil, apperr.Unauth("login required")
	}
	return a, nil
}

// Need is AuthOf plus a permission check (403 "missing <perm>").
func Need(r *http.Request, perm shared.Permission) (*auth.Ctx, error) {
	a, err := AuthOf(r)
	if err != nil {
		return nil, err
	}
	if !shared.HasPermission(&a.Principal, perm) {
		return nil, apperr.NewForbidden("missing " + string(perm))
	}
	return a, nil
}

func (d *Deps) CookieName() string {
	if d.Cfg.IsHTTPS() {
		return "__Host-sid"
	}
	return "sid"
}

var bearerRe = regexp.MustCompile(`(?i)^Bearer (.+)$`)

// attachAuth resolves the session from Bearer or cookie. Cookie sessions need CSRF proof on unsafe methods;
// bearer tokens are not ambient credentials.
func (d *Deps) attachAuth(r *http.Request) (*auth.Ctx, error) {
	var raw string
	bearer := false
	if m := bearerRe.FindStringSubmatch(r.Header.Get("Authorization")); m != nil {
		raw, bearer = m[1], true
	} else if c, err := r.Cookie(d.CookieName()); err == nil {
		raw = c.Value
	}
	if raw == "" {
		return nil, nil
	}
	s, err := auth.LoadSession(r.Context(), d.DB, raw)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, nil
	}
	if !bearer && r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
		h := r.Header.Get("X-CSRF-Token")
		if h == "" || !crypto.SafeEqual(crypto.Sha256HexString(h), crypto.Sha256HexString(s.Session.CSRF)) {
			return nil, apperr.NewForbidden("CSRF token missing or invalid")
		}
	}
	return &auth.Ctx{Principal: s.Principal, Email: s.Email, Name: s.Name, Kind: s.Session.Kind, CSRF: s.Session.CSRF,
		AuthTime: s.Session.AuthTime, SessionExpires: s.Session.ExpiresAt, RawSessionID: raw}, nil
}

// ---- rate limiting (fixed window per route+client IP, like @fastify/rate-limit)

type Rate struct {
	Max    int
	Window time.Duration
}

var DefaultRate = Rate{Max: 300, Window: time.Minute}

type bucket struct {
	n     int
	reset time.Time
}

type Limiter struct {
	mu sync.Mutex
	m  map[string]*bucket
}

func NewLimiter() *Limiter { return &Limiter{m: map[string]*bucket{}} }

// Allow counts one hit; ok=false once Max is exceeded within the window.
func (l *Limiter) Allow(key string, rate Rate) (ok bool, retryAfter time.Duration) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.m) > 20000 {
		for k, b := range l.m {
			if now.After(b.reset) {
				delete(l.m, k)
			}
		}
	}
	b := l.m[key]
	if b == nil || now.After(b.reset) {
		b = &bucket{reset: now.Add(rate.Window)}
		l.m[key] = b
	}
	b.n++
	if b.n > rate.Max {
		return false, time.Until(b.reset)
	}
	return true, 0
}

// ---- router

// Opts configures a route.
type Opts struct {
	Public bool  // no session required (a bad session is ignored)
	Rate   *Rate // nil = default 300/min
}

type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Router registers /api/v1 routes on a ServeMux with the common pipeline.
type Router struct {
	Mux     *http.ServeMux
	D       *Deps
	Prefix  string
	limiter *Limiter
}

func NewRouter(mux *http.ServeMux, d *Deps, prefix string) *Router {
	return &Router{Mux: mux, D: d, Prefix: prefix, limiter: NewLimiter()}
}

// Handle registers method+path (path relative to the prefix, ServeMux pattern syntax such as /transfers/{id}).
func (rt *Router) Handle(method, path string, o Opts, h HandlerFunc) {
	pattern := method + " " + rt.Prefix + path
	rate := DefaultRate
	if o.Rate != nil {
		rate = *o.Rate
	}
	rt.Mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		ip := rt.D.ClientIP(r)
		if ok, retry := rt.limiter.Allow(pattern+"|"+ip, rate); !ok {
			w.Header().Set("Retry-After", itoa(int(retry.Seconds())+1))
			WriteJSON(w, 429, errorResponse(apperr.RateLimited, "too many requests", nil))
			return
		}
		// authenticate before bodies are read (large uploads must not be buffered for anonymous callers)
		a, err := rt.D.attachAuth(r)
		if err != nil && !o.Public {
			WriteError(w, rt.D.Log, err)
			return
		}
		if err != nil {
			a = nil
		}
		if a == nil && !o.Public {
			WriteError(w, rt.D.Log, apperr.Unauth("login required"))
			return
		}
		if a != nil {
			if securetransport.IsEncrypted(r.Context()) && securetransport.ClientKind(r.Context()) != string(a.Kind) {
				WriteError(w, rt.D.Log, apperr.Forbiddenf("secure channel client kind does not match session"))
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), authKey, a))
		}
		r = r.WithContext(reqmeta.With(r.Context(), rt.D.requestMeta(w, r, a)))
		if err := h(w, r); err != nil {
			WriteError(w, rt.D.Log, err)
		}
	})
}

func (rt *Router) GET(path string, o Opts, h HandlerFunc)    { rt.Handle("GET", path, o, h) }
func (rt *Router) POST(path string, o Opts, h HandlerFunc)   { rt.Handle("POST", path, o, h) }
func (rt *Router) PUT(path string, o Opts, h HandlerFunc)    { rt.Handle("PUT", path, o, h) }
func (rt *Router) DELETE(path string, o Opts, h HandlerFunc) { rt.Handle("DELETE", path, o, h) }

func itoa(n int) string {
	var b strings.Builder
	if n == 0 {
		return "0"
	}
	var d []byte
	for ; n > 0; n /= 10 {
		d = append([]byte{byte('0' + n%10)}, d...)
	}
	b.Write(d)
	return b.String()
}

// EncodeURIComponent mirrors JavaScript's encodeURIComponent.
func EncodeURIComponent(s string) string {
	const hexd = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexd[c>>4])
			b.WriteByte(hexd[c&15])
		}
	}
	return b.String()
}

// ISO formats a time like JS Date.prototype.toISOString.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// requestMeta collects the trace fields recorded in every audit entry of this request. Tokens are never included: the session
// is referenced by a 12-hex prefix of its stored hash.
func (d *Deps) requestMeta(w http.ResponseWriter, r *http.Request, a *auth.Ctx) reqmeta.Meta {
	m := reqmeta.Meta{RequestID: w.Header().Get("X-Request-ID"), IP: d.ClientIP(r), UserAgent: inspect.SanitizeName(r.Header.Get("User-Agent"), 200)}
	if d.Cfg.TrustProxy {
		m.XFF = inspect.SanitizeName(r.Header.Get("X-Forwarded-For"), 300)
	}
	if a != nil {
		m.ClientKind = string(a.Kind)
		if a.RawSessionID != "" {
			m.SessionRef = crypto.Sha256HexString(a.RawSessionID)[:12]
		}
	}
	return m
}
