// Package diskguard keeps the volume holding the file store and the logs below DISK_MAX_USED_PCT: it measures the volume,
// admits or refuses uploads (HTTP 507) and exposes the state for the health endpoint. The janitor (janitor.go) frees space.
package diskguard

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"vnpay/tabledb-api/internal/apperr"
)

type Usage struct{ Total, Used, Avail uint64 }

// UsedPct follows df: used / (used + available).
func (u Usage) UsedPct() float64 {
	d := u.Used + u.Avail
	if d == 0 {
		return 0
	}
	return float64(u.Used) * 100 / float64(d)
}

type State string

const (
	StateOK      State = "ok"
	StateWarn    State = "warn"    // within 5 points of the limit
	StateBlocked State = "blocked" // at/over the limit and the janitor could not free enough: new uploads are refused
)

type Status struct {
	State      State     `json:"state"`
	UsedPct    float64   `json:"usedPct"`
	LimitPct   float64   `json:"limitPct"`
	UsedBytes  uint64    `json:"usedBytes"`
	TotalBytes uint64    `json:"totalBytes"`
	AvailBytes uint64    `json:"availBytes"`
	Volume     string    `json:"volume,omitempty"`
	CheckedAt  time.Time `json:"checkedAt"`
	Error      string    `json:"error,omitempty"`
}

type Guard struct {
	LimitPct     float64
	ReserveBytes uint64
	// Paths are the directories whose volumes are watched; Paths[0] is the file store (uploads land there).
	Paths []string
	// StatFn is injectable for tests; defaults to Stat.
	StatFn func(path string) (Usage, error)
	Now    func() time.Time

	mu      sync.Mutex
	blocked bool
	last    Status
}

func (g *Guard) stat(p string) (Usage, error) {
	if g.StatFn != nil {
		return g.StatFn(p)
	}
	return Stat(existing(p))
}

// existing walks up to the closest existing directory so a not-yet-created STORAGE_DIR can still be measured.
func existing(p string) string {
	for {
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			return p
		}
		p = parent
	}
}

func (g *Guard) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// Measure reads every watched volume and returns the fullest one.
func (g *Guard) Measure() Status {
	st := Status{LimitPct: g.LimitPct, CheckedAt: g.now()}
	var worst Usage
	seen := false
	for _, p := range g.Paths {
		u, err := g.stat(p)
		if err != nil {
			st.Error = err.Error()
			continue
		}
		if !seen || u.UsedPct() > worst.UsedPct() {
			worst, seen, st.Volume = u, true, p
		}
	}
	if seen {
		st.UsedPct, st.UsedBytes, st.TotalBytes, st.AvailBytes = worst.UsedPct(), worst.Used, worst.Total, worst.Avail
	}
	return st
}

func (g *Guard) classify(st Status, blocked bool) Status {
	switch {
	case blocked && st.UsedPct >= g.LimitPct-2:
		st.State = StateBlocked
	case st.UsedPct >= g.LimitPct-5:
		st.State = StateWarn
	default:
		st.State = StateOK
	}
	return st
}

// Check measures and records the status (used by the janitor and the health endpoint).
func (g *Guard) Check() Status {
	st := g.Measure()
	g.mu.Lock()
	defer g.mu.Unlock()
	if st.UsedPct < g.LimitPct-2 {
		g.blocked = false
	}
	g.last = g.classify(st, g.blocked)
	return g.last
}

// SetBlocked is called by the janitor when cleanup could not get below the limit (and cleared when it did).
func (g *Guard) SetBlocked(b bool) {
	g.mu.Lock()
	g.blocked = b
	g.last = g.classify(g.last, b)
	g.mu.Unlock()
}

// Status is the last recorded status (measured on demand when none yet).
func (g *Guard) Status() Status {
	g.mu.Lock()
	ok := !g.last.CheckedAt.IsZero()
	last := g.last
	g.mu.Unlock()
	if !ok {
		return g.Check()
	}
	return last
}

// LimitBytes is the most that may be used on a volume of the given total.
func (g *Guard) LimitBytes(total uint64) uint64 { return uint64(float64(total) * g.LimitPct / 100) }

// Admit is the admission control before accepting `size` more bytes into the file store: refuse when the volume would pass
// the limit with size×1.1 (ciphertext + framing overhead) plus the reserve, or when the janitor flagged the volume blocked.
func (g *Guard) Admit(size int64) error {
	if g == nil || len(g.Paths) == 0 {
		return nil
	}
	u, err := g.stat(g.Paths[0])
	if err != nil {
		return nil // an unreadable volume must not take the service down; the health endpoint reports the error
	}
	need := uint64(float64(size)*1.1) + g.ReserveBytes
	if size < 0 {
		need = g.ReserveBytes
	}
	limit := g.LimitBytes(u.Total)
	g.mu.Lock()
	blocked := g.blocked
	g.mu.Unlock()
	if (blocked && u.UsedPct() >= g.LimitPct-2) || u.Used+need > limit {
		return &apperr.Error{Code: apperr.InsufficientStorage,
			Message: fmt.Sprintf("server storage is full (%.1f%% used, limit %.0f%%); new uploads are temporarily refused", u.UsedPct(), g.LimitPct),
			Details: map[string]any{"usedPct": round1(u.UsedPct()), "limitPct": g.LimitPct}}
	}
	return nil
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }
