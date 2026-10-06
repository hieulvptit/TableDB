// Package server wires the dependency bundle, the middleware chain (request id, logging, security headers, CORS)
// and the routes into an http.Handler.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/routes"
	"vnpay/tabledb-api/internal/securetransport"
)

// RegisterAgentRoutes mounts the Agent routes. The Agent itself runs in the desktop app; the server only has the audit sink
// (POST /api/v1/agent/audit, see internal/agent). Assigned from an init() in agent.go.
var RegisterAgentRoutes = func(rt *app.Router, d *app.Deps) {}

// Handler builds the full HTTP handler.
func Handler(d *app.Deps) http.Handler {
	mux := http.NewServeMux()
	rt := app.NewRouter(mux, d, "/api/v1")
	routes.Register(rt)
	RegisterAgentRoutes(rt, d)

	root := app.NewRouter(mux, d, "")
	root.GET("/healthz", app.Opts{Public: true}, func(w http.ResponseWriter, r *http.Request) error {
		out := map[string]any{"ok": true}
		if disk := diskStatus(d); disk != nil {
			out["disk"] = disk
		}
		app.WriteJSON(w, 200, out)
		return nil
	})
	root.GET("/readyz", app.Opts{Public: true}, func(w http.ResponseWriter, r *http.Request) error {
		var one int
		dbOK := d.DB.QueryRow(r.Context(), "SELECT 1").Scan(&one) == nil
		storeOK := d.Store.Ping()
		st := 200
		if !dbOK || !storeOK {
			st = 503
		}
		out := map[string]any{"db": dbOK, "storage": storeOK}
		if disk := diskStatus(d); disk != nil {
			out["disk"] = disk
		}
		app.WriteJSON(w, st, out)
		return nil
	})
	// unknown routes (and wrong methods) answer 404 in the API error shape, like Fastify
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		app.WriteJSON(w, 404, map[string]any{"error": map[string]any{"code": "NOT_FOUND", "message": "Route " + r.Method + ":" + r.URL.Path + " not found"}})
	})

	var h http.Handler = mux
	if d.Cfg.SecureTransportEnabled {
		settings := d.Cfg.SecureTransport
		settings.ClientIP = d.ClientIP
		transport, err := securetransport.New(settings)
		if err != nil {
			panic("invalid secure transport configuration")
		}
		h = transport.Wrap(h)
	} else {
		next := h
		h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/v1/secure/client.js" && r.Method == "GET" {
				securetransport.BrowserModule(w, r, "", false)
				return
			}
			if r.URL.Path == "/api/v1/secure/info" && r.Method == "GET" {
				app.WriteJSON(w, 200, map[string]any{"enabled": false})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	h = cors(d, h)
	h = securityHeaders(d, h)
	h = requestLog(d, h)
	h = recoverer(d, h)
	return h
}

// ---- middleware

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wrote {
		s.status, s.wrote = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}
func (s *statusWriter) Write(b []byte) (int, error) {
	if !s.wrote {
		s.status, s.wrote = 200, true
	}
	return s.ResponseWriter.Write(b)
}
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

var reqIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func newRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func recoverer(d *app.Deps, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				d.Log.Error("panic", "panic", strings.ReplaceAll(sprint(rec), "\n", " "))
				app.WriteJSON(w, 500, map[string]any{"error": map[string]any{"code": "INTERNAL", "message": "internal error"}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLog assigns/echoes X-Request-ID and logs one structured line per request. It never logs headers,
// bodies or the query string (download tokens travel in the query).
func requestLog(d *app.Deps, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !reqIDRe.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		sw := &statusWriter{ResponseWriter: w, status: 200}
		start := time.Now()
		next.ServeHTTP(sw, r)
		if d.Cfg.Env == "test" {
			return
		}
		d.Log.Info("request", slog.String("request_id", id), slog.String("method", r.Method), slog.String("path", r.URL.Path),
			slog.Int("status", sw.status), slog.Int64("ms", time.Since(start).Milliseconds()), slog.String("ip", d.ClientIP(r)))
	})
}

func securityHeaders(d *app.Deps, next http.Handler) http.Handler {
	hsts := d.Cfg.IsHTTPS()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store") // handlers may override
		if hsts {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// cors: only for the desktop app's WebView origins (bearer tokens, no cookies => no Allow-Credentials). The web BO is same-origin.
func cors(d *app.Deps, next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range d.Cfg.CorsOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !allowed[origin] {
			if r.Method == http.MethodOptions {
				app.WriteJSON(w, 403, map[string]any{"error": map[string]any{"code": "FORBIDDEN", "message": "origin not allowed"}})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Expose-Headers", "x-content-sha256, content-disposition, x-stepup")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "authorization, content-type, idempotency-key, x-part-sha256, x-csrf-token, x-tabledb-session, x-tabledb-sequence")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// diskStatus is the public disk summary for health probes: used%, limit and state (ok | warn | blocked). No paths.
func diskStatus(d *app.Deps) map[string]any {
	if d.Disk == nil {
		return nil
	}
	st := d.Disk.Status()
	return map[string]any{"usedPct": float64(int64(st.UsedPct*10+0.5)) / 10, "limitPct": st.LimitPct, "state": st.State}
}
