// Command server is the Go port of services/api (Fastify): same /api/v1 surface, same env vars, same migrations.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/logsink"
	"vnpay/tabledb-api/internal/migrate"
	"vnpay/tabledb-api/internal/server"
)

func envMap() map[string]string {
	m := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return m
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	env := envMap()
	cfg, err := config.Load(env)
	if err != nil {
		return err
	}
	logs, err := server.OpenLogs(cfg)
	if err != nil {
		// a read-only install directory (container, hardened service) must not stop the server: stdout logging continues
		fmt.Fprintf(os.Stderr, "warning: log directory %s unusable (%v); file logs and the audit file copy are disabled\n", cfg.LogDir, err)
		logs = &server.Logs{}
	}
	defer logs.Close()
	log := server.AppLogger(cfg, logs)
	slog.SetDefault(log)
	log.Info("paths", "base_dir", cfg.BaseDir, "storage_dir", cfg.StorageDir, "log_dir", cfg.LogDir)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// database: DATABASE_URL (prod) or an embedded PostgreSQL (dev/test; replaces PGlite)
	var embedded *db.Embedded
	dbURL := cfg.DatabaseURL
	if dbURL == "" {
		if cfg.Env == "prod" {
			return errors.New("DATABASE_URL required in prod")
		}
		log.Info("starting embedded PostgreSQL (first run downloads the binaries)", "data_dir", cfg.PgliteDir)
		embedded, err = db.StartEmbedded(cfg.PgliteDir, io.Discard)
		if err != nil {
			return err
		}
		defer embedded.Stop() //nolint:errcheck
		dbURL = embedded.URL
	}
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	applied, err := migrate.Run(ctx, pool)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if len(applied) > 0 {
		log.Info("migrations applied", "files", applied)
	}

	// DEV ONLY: DEV_SEED_LEADERS="a@vnpay.vn:Tên A,b@vnpay.vn:Tên B" pre-creates approver users. Idempotent; refused in prod.
	if spec := env["DEV_SEED_LEADERS"]; spec != "" {
		if err := server.SeedLeaders(ctx, cfg, pool, spec); err != nil {
			return err
		}
		log.Warn("[dev] seeded leaders: " + spec)
	}

	if cfg.DataKey == "" {
		if cfg.Env == "prod" {
			return errors.New("DATA_KEY required")
		}
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		cfg.DataKey = base64.StdEncoding.EncodeToString(b)
		log.Warn("[dev] DATA_KEY not set: using an ephemeral key; encrypted data will not survive restart")
	}

	deps, err := server.BuildDeps(cfg, pool, server.Overrides{Log: log})
	if err != nil {
		return err
	}
	worker := server.NewWorker(deps)
	worker.Start(ctx)

	var bg sync.WaitGroup
	if logs.Audit != nil {
		sink := &logsink.AuditSink{Q: pool, W: logs.Audit, Dir: cfg.LogDir, Interval: time.Second, Log: log}
		bg.Add(1)
		go func() { defer bg.Done(); sink.Run(ctx) }()
	}
	if deps.Disk != nil {
		jan := server.NewJanitor(deps, log)
		bg.Add(1)
		go func() { defer bg.Done(); jan.Run(ctx, time.Duration(cfg.DiskCheckIntervalSec)*time.Second) }()
	}

	srv := &http.Server{
		Addr: net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), Handler: server.Handler(deps),
		ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 120 * time.Second,
	}
	errc := make(chan error, 1)
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		worker.Stop()
		return err
	}
	go func() { errc <- srv.Serve(ln) }()
	log.Info("listening", "addr", ln.Addr().String(), "env", cfg.Env)

	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-errc:
		worker.Stop()
		return err
	}
	shCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	worker.Stop()
	if err := srv.Shutdown(shCtx); err != nil {
		log.Error("shutdown", "err", err.Error())
	}
	stop()
	bg.Wait()
	return nil
}
