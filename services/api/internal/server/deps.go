package server

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/diskguard"
	"vnpay/tabledb-api/internal/hrm"
	"vnpay/tabledb-api/internal/httpx"
	"vnpay/tabledb-api/internal/mail"
	"vnpay/tabledb-api/internal/outbox"
	"vnpay/tabledb-api/internal/pii"
	"vnpay/tabledb-api/internal/scan"
	"vnpay/tabledb-api/internal/store"
	"vnpay/tabledb-api/internal/tickets"
)

func sprint(v any) string { return fmt.Sprint(v) }

// Overrides lets tests (and phase 2) replace adapters; zero values pick the configured production adapters.
type Overrides struct {
	Mailer  mail.Mailer
	Scanner scan.Scanner
	PII     pii.Checker
	Store   store.FileStore
	Keys    crypto.KeyProvider
	Now     func() time.Time
	Log     *slog.Logger
	// Disk replaces the disk guard (tests inject a fake volume). In APP_ENV=test no guard is created unless this is set.
	Disk *diskguard.Guard
}

// BuildDeps assembles the dependency bundle from the config (the equivalent of Ctx in main.ts).
func BuildDeps(cfg *config.Config, pool *db.Pool, o Overrides) (*app.Deps, error) {
	out := httpx.NewOutbound(cfg.OutboundProxies)
	keys := o.Keys
	if keys == nil {
		if cfg.DataKey == "" {
			return nil, fmt.Errorf("DATA_KEY required")
		}
		k, err := crypto.NewStaticKeyProvider(cfg.DataKey)
		if err != nil {
			return nil, err
		}
		keys = k
	}
	genai, err := auth.NewGenaiVerifier(out, cfg.Genai)
	if err != nil {
		return nil, err
	}
	mailer := o.Mailer
	if mailer == nil {
		if cfg.DevLogMail {
			mailer = mail.DevLog{}
		} else {
			mailer = mail.New(cfg.SMTP)
		}
	}
	scanner := o.Scanner
	if scanner == nil {
		scanner = scan.DisabledScanner{}
	}
	st := o.Store
	if st == nil {
		st = store.NewLocal(cfg.StorageDir)
	}
	now := o.Now
	if now == nil {
		now = time.Now
	}
	log := o.Log
	if log == nil {
		log = NewLogger(os.Stdout, slog.LevelInfo)
	}
	h := &hrm.Client{Cfg: cfg.HRM, Out: out}
	d := &app.Deps{Cfg: cfg, DB: pool, Keys: keys, Out: out, OIDC: auth.NewOIDC(out), Genai: genai, Mailer: mailer, Scanner: scanner, Store: st,
		HRM: h, Now: now, Log: log}
	guard := o.Disk
	if guard == nil && cfg.Env != "test" {
		guard = &diskguard.Guard{LimitPct: cfg.DiskMaxUsedPct, ReserveBytes: uint64(cfg.DiskReserveMB) << 20, Paths: []string{cfg.StorageDir, cfg.LogDir}, Now: now}
	}
	d.Disk = guard
	d.Tickets = &tickets.Service{Cfg: cfg, DB: pool, Keys: keys, Store: st, Scanner: scanner, Mailer: mailer, HRM: h, Now: now}
	if cfg.PII.Enabled {
		d.Tickets.PII = o.PII
		if d.Tickets.PII == nil {
			d.Tickets.PII = &pii.LLM{Config: cfg.PII, Out: out}
		}
	}
	if guard != nil {
		d.Tickets.Disk = guard
	}
	return d, nil
}

// NewWorker builds the outbox worker (scan, emails, purge, rescan) with the expiry sweeper.
func NewWorker(d *app.Deps) *outbox.Worker {
	return &outbox.Worker{
		Q: d.DB, Handlers: d.Tickets.Handlers(), OnDead: d.Tickets.OnDead,
		Sweep: func(ctx context.Context) {
			if _, err := d.Tickets.SweepExpired(ctx); err != nil && ctx.Err() == nil {
				d.Log.Error("sweep failed", "err", err.Error())
			}
		},
	}
}

// SeedLeaders implements DEV_SEED_LEADERS="a@vnpay.vn:Name A,b@vnpay.vn:Name B" (idempotent; refused in prod).
func SeedLeaders(ctx context.Context, cfg *config.Config, pool *db.Pool, spec string) error {
	if cfg.Env == "prod" {
		return fmt.Errorf("DEV_SEED_LEADERS is not allowed in prod")
	}
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		email, rest, _ := strings.Cut(item, ":")
		name := strings.TrimSpace(rest)
		if name == "" {
			name = strings.Split(email, "@")[0]
		}
		email = strings.ToLower(email)
		err := pool.InTx(ctx, func(t db.Runner) error {
			var id string
			err := t.QueryRow(ctx, "SELECT id::text FROM users WHERE lower(email)=$1", email).Scan(&id)
			if db.IsNoRows(err) {
				err = t.QueryRow(ctx, `INSERT INTO users (provider, subject, email, name) VALUES ('dev-seed',$1,$1,$2) RETURNING id::text`, email, name).Scan(&id)
			} else if err == nil {
				_, err = t.Exec(ctx, "UPDATE users SET name=$2 WHERE id=$1 AND provider='dev-seed'", id, name)
			}
			if err != nil {
				return err
			}
			if _, err := t.Exec(ctx, "INSERT INTO leaders (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET enabled=true", id); err != nil {
				return err
			}
			for _, r := range []string{"user", "leader"} {
				if _, err := t.Exec(ctx, "INSERT INTO role_assignments (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING", id, r); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return fmt.Errorf("seed leader %s: %w", email, err)
		}
	}
	return nil
}
