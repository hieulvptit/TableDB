package server

import (
	"context"
	"io"
	"log/slog"
	"os"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/diskguard"
	"vnpay/tabledb-api/internal/logsink"
)

// Logs are the rotating file writers (nil members when disabled).
type Logs struct {
	App   *logsink.Rolling
	Audit *logsink.Rolling
}

func (l *Logs) Close() {
	if l == nil {
		return
	}
	if l.App != nil {
		_ = l.App.Close()
	}
	if l.Audit != nil {
		_ = l.Audit.Close()
	}
}

// OpenLogs creates LOG_DIR and the rotating files: app.log (slog JSON) and audit.jsonl (audit sink copy, never age-pruned
// by the rotator — only the disk janitor may remove old segments, and only under its rules).
func OpenLogs(cfg *config.Config) (*Logs, error) {
	l := &Logs{}
	if cfg.LogFileEnabled {
		app, err := logsink.NewRolling(logsink.AppLogName, logsink.Options{Dir: cfg.LogDir, MaxSizeMB: cfg.LogMaxSizeMB, MaxAgeDays: cfg.LogMaxAgeDays, MaxBackups: cfg.LogMaxBackups, Daily: cfg.LogRotateDaily})
		if err != nil {
			return nil, err
		}
		l.App = app
	}
	if cfg.AuditFileEnabled {
		au, err := logsink.NewRolling(logsink.AuditFileName, logsink.Options{Dir: cfg.LogDir, MaxSizeMB: cfg.LogMaxSizeMB, Daily: cfg.LogRotateDaily})
		if err != nil {
			return nil, err
		}
		l.Audit = au
	}
	return l, nil
}

// AppLogger is the redacting slog logger writing to stdout (LOG_STDOUT) and/or app.log.
func AppLogger(cfg *config.Config, l *Logs) *slog.Logger {
	var ws []io.Writer
	if cfg.LogToStdout || l == nil || l.App == nil {
		ws = append(ws, os.Stdout)
	}
	if l != nil && l.App != nil {
		ws = append(ws, l.App)
	}
	return NewLogger(io.MultiWriter(ws...), slog.LevelInfo)
}

// NewJanitor wires the disk janitor to the file store, the log directory and the audit trail.
func NewJanitor(d *app.Deps, log *slog.Logger) *diskguard.Janitor {
	return &diskguard.Janitor{
		Guard: d.Disk, LogDir: d.Cfg.LogDir, AuditMinRetain: time.Duration(d.Cfg.AuditFileMinRetainDays) * 24 * time.Hour, Now: d.Now, Log: log,
		PurgeTerminal: func(ctx context.Context) (int, int64, error) {
			return d.Tickets.PurgeTerminalStorage(ctx, "disk-pressure")
		},
		Alert: func(ctx context.Context, state diskguard.State, st diskguard.Status, actions []string) {
			label := map[diskguard.State]string{diskguard.StateBlocked: "blocked", diskguard.StateWarn: "cleaned", diskguard.StateOK: "recovered"}[state]
			if actions == nil {
				actions = []string{}
			}
			err := d.Tickets.AuditSystem(ctx, "storage.pressure", "storage", "disk", map[string]any{"state": label, "usedPct": float64(int64(st.UsedPct*10+0.5)) / 10,
				"limitPct": st.LimitPct, "actions": actions, "availBytes": st.AvailBytes, "totalBytes": st.TotalBytes})
			if err != nil {
				log.Error("audit storage.pressure failed", "err", err.Error())
			}
		},
	}
}
