// Package app is the shared HTTP plumbing: the dependency bundle, route registration (auth, CSRF, rate limit,
// error mapping) and request/response helpers. Feature packages (routes, and phase 2's agent) build on it.
package app

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/diskguard"
	"vnpay/tabledb-api/internal/hrm"
	"vnpay/tabledb-api/internal/httpx"
	"vnpay/tabledb-api/internal/mail"
	"vnpay/tabledb-api/internal/scan"
	"vnpay/tabledb-api/internal/store"
	"vnpay/tabledb-api/internal/tickets"
)

// Deps is everything routes and background jobs need; built once in main (prod) or by tests (with fakes).
// Extend it by adding fields.
type Deps struct {
	Cfg     *config.Config
	DB      db.Runner
	Keys    crypto.KeyProvider
	Out     *httpx.Outbound
	OIDC    *auth.OIDC
	Genai   auth.GenaiVerifier
	Mailer  mail.Mailer
	Scanner scan.Scanner
	Store   store.FileStore
	HRM     *hrm.Client
	Tickets *tickets.Service
	Now     func() time.Time
	Log     *slog.Logger
	// Disk is the disk budget guard (nil = not enforced, e.g. in tests).
	Disk *diskguard.Guard
}

// ClientIP is the caller address: leftmost X-Forwarded-For entry when TRUST_PROXY=1 (behind nginx/WAF), else the socket peer.
func (d *Deps) ClientIP(r *http.Request) string {
	if d.Cfg.TrustProxy {
		if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
			if ip := strings.TrimSpace(strings.Split(xf, ",")[0]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
