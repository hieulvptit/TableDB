package diskguard

import (
	"context"
	"log/slog"
	"os"
	"time"

	"vnpay/tabledb-api/internal/logsink"
)

// Hysteresis: cleanup starts at the limit and keeps going until usage is below limit - Hysteresis.
const Hysteresis = 2.0

// Janitor enforces the disk budget. Deletion policy, in this order, stopping as soon as below limit-2:
//  1. rotated APP log segments, oldest first;
//  2. ciphertext of tickets already terminal (expired/revoked/rejected/aborted/quarantined) still on disk (reason disk-pressure);
//  3. rotated AUDIT file segments, oldest first, only when older than AuditMinRetain AND the DB chain was verified (or fully
//     exported) after the segment was closed. These files are COPIES: the DB holds the authoritative chain, so no audit data is lost;
//  4. never live data, the live logs or the database. If still at/over the limit the guard flips to "blocked" (uploads get 507)
//     and a storage.pressure alert is emitted.
type Janitor struct {
	Guard          *Guard
	LogDir         string
	AuditMinRetain time.Duration
	Now            func() time.Time
	Log            *slog.Logger

	// PurgeTerminal deletes ciphertext of terminal tickets (audited as storage.purge, reason disk-pressure).
	PurgeTerminal func(ctx context.Context) (tickets int, bytes int64, err error)
	// Alert records the pressure transition in the audit trail.
	Alert func(ctx context.Context, state State, st Status, actions []string)
	// Remove is os.Remove unless replaced by a test.
	Remove func(path string) error

	lastAlert State
}

// Result describes one tick.
type Result struct {
	Before, After Status
	AppDeleted    []string
	AuditDeleted  []string
	PurgedTickets int
	Blocked       bool
}

func (j *Janitor) now() time.Time {
	if j.Now != nil {
		return j.Now()
	}
	return time.Now()
}

func (j *Janitor) remove(p string) error {
	if j.Remove != nil {
		return j.Remove(p)
	}
	return os.Remove(p)
}

func (j *Janitor) log() *slog.Logger {
	if j.Log != nil {
		return j.Log
	}
	return slog.Default()
}

// Tick measures and, when at/over the limit, frees space following the policy above.
func (j *Janitor) Tick(ctx context.Context) Result {
	g := j.Guard
	res := Result{Before: g.Check()}
	res.After = res.Before
	target := g.LimitPct - Hysteresis
	if res.Before.UsedPct < g.LimitPct {
		if j.lastAlert == StateBlocked && res.Before.UsedPct < target {
			j.lastAlert = StateOK
			if j.Alert != nil {
				j.Alert(ctx, StateOK, res.Before, nil)
			}
		}
		return res
	}
	var actions []string
	below := func() bool {
		res.After = g.Check()
		return res.After.UsedPct < target
	}

	// 1. app logs
	if segs, err := logsink.Segments(j.LogDir, logsink.AppLogName); err == nil {
		for _, s := range segs {
			if ctx.Err() != nil {
				return res
			}
			if err := j.remove(s.Path); err == nil {
				res.AppDeleted = append(res.AppDeleted, s.Path)
				actions = append(actions, "app-log")
				if below() {
					return j.finish(ctx, &res, actions)
				}
			}
		}
	}
	// 2. ciphertext of terminal tickets
	if j.PurgeTerminal != nil && ctx.Err() == nil {
		if n, _, err := j.PurgeTerminal(ctx); err != nil {
			j.log().Error("disk janitor: purge terminal tickets", "err", err.Error())
		} else if n > 0 {
			res.PurgedTickets = n
			actions = append(actions, "purge-terminal")
			if below() {
				return j.finish(ctx, &res, actions)
			}
		}
	}
	// 3. audit file copies: old enough AND verified/exported after they were closed
	if mk, ok := logsink.ReadMarker(j.LogDir); ok && mk.OK {
		if segs, err := logsink.Segments(j.LogDir, logsink.AuditFileName); err == nil {
			cutoff := j.now().Add(-j.AuditMinRetain)
			for _, s := range segs {
				if ctx.Err() != nil {
					return res
				}
				if !s.ModTime.Before(cutoff) || s.ModTime.After(mk.At) {
					continue // too young for deletion, or closed after the last verification
				}
				if err := j.remove(s.Path); err == nil {
					res.AuditDeleted = append(res.AuditDeleted, s.Path)
					actions = append(actions, "audit-file-copy")
					if below() {
						return j.finish(ctx, &res, actions)
					}
				}
			}
		}
	}
	// 4. nothing else may be deleted
	res.After = g.Check()
	return j.finish(ctx, &res, actions)
}

func (j *Janitor) finish(ctx context.Context, res *Result, actions []string) Result {
	g := j.Guard
	res.After = g.Check()
	if res.After.UsedPct >= g.LimitPct {
		g.SetBlocked(true)
		res.After = g.Status()
		res.Blocked = true
		j.log().Warn("disk budget exceeded: new uploads are refused", "used_pct", res.After.UsedPct, "limit_pct", g.LimitPct, "actions", actions)
		if j.lastAlert != StateBlocked && j.Alert != nil {
			j.Alert(ctx, StateBlocked, res.After, actions)
		}
		j.lastAlert = StateBlocked
		return *res
	}
	g.SetBlocked(false)
	res.After = g.Status()
	j.log().Info("disk janitor freed space", "used_pct", res.After.UsedPct, "limit_pct", g.LimitPct, "actions", actions)
	if j.Alert != nil && len(actions) > 0 {
		j.Alert(ctx, StateWarn, res.After, actions)
	}
	if j.lastAlert == StateBlocked {
		j.lastAlert = StateOK
	}
	return *res
}

// Run ticks every interval until ctx is done.
func (j *Janitor) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	j.Tick(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			j.Tick(ctx)
		}
	}
}
