package diskguard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/logsink"
)

// sim is a fake volume: used = base + everything under dir + purgeable ciphertext. Files are real (so the janitor's os.Remove is real).
type sim struct {
	t         *testing.T
	dir       string
	total     uint64
	base      uint64
	purgeable uint64
	now       time.Time
	purged    int
	alerts    []State
}

func newSim(t *testing.T, base uint64) *sim {
	return &sim{t: t, dir: filepath.Join(t.TempDir(), "Tài liệu và dữ liệu", "logs"), total: 20000, base: base, now: time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)}
}

func (s *sim) file(name string, size int, age time.Duration) string {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		s.t.Fatal(err)
	}
	p := filepath.Join(s.dir, name)
	if err := os.WriteFile(p, make([]byte, size), 0o640); err != nil {
		s.t.Fatal(err)
	}
	mt := s.now.Add(-age)
	if err := os.Chtimes(p, mt, mt); err != nil {
		s.t.Fatal(err)
	}
	return p
}

func (s *sim) used() uint64 { return s.base + uint64(logsink.DirSize(s.dir)) + s.purgeable }

func (s *sim) guard() *Guard {
	return &Guard{LimitPct: 90, Paths: []string{s.dir}, Now: func() time.Time { return s.now }, StatFn: func(string) (Usage, error) {
		u := s.used()
		return Usage{Total: s.total, Used: u, Avail: s.total - u}, nil
	}}
}

func (s *sim) janitor(g *Guard) *Janitor {
	return &Janitor{Guard: g, LogDir: s.dir, AuditMinRetain: 90 * 24 * time.Hour, Now: func() time.Time { return s.now },
		PurgeTerminal: func(context.Context) (int, int64, error) {
			if s.purgeable == 0 {
				return 0, 0, nil
			}
			b := s.purgeable
			s.purgeable = 0
			s.purged++
			return 1, int64(b), nil
		},
		Alert: func(_ context.Context, st State, _ Status, _ []string) { s.alerts = append(s.alerts, st) }}
}

func names(ps []string) string {
	var out []string
	for _, p := range ps {
		out = append(out, filepath.Base(p))
	}
	return strings.Join(out, ",")
}

const day = 24 * time.Hour

func TestJanitorDeletesInPolicyOrderAndStopsBelowHysteresis(t *testing.T) {
	s := newSim(t, 15000)
	s.file("app.log", 300, 0) // live files are never touched
	s.file("audit.jsonl", 300, 0)
	s.file("app-2026-09-01T00-00-00.000.log.gz", 500, 30*day)
	s.file("app-2026-09-15T00-00-00.000.log.gz", 500, 17*day)
	s.file("app-2026-09-30T00-00-00.000.log", 500, 2*day)
	s.purgeable = 700
	s.file("audit-2026-05-01T00-00-00.000.jsonl.gz", 500, 150*day)
	s.file("audit-2026-06-01T00-00-00.000.jsonl.gz", 500, 120*day)
	// 15000+300+300+1500+700+1000 = 18800 = 94%
	if err := logsink.WriteMarker(s.dir, logsink.Marker{At: s.now.Add(-day), OK: true, ThroughSeq: 100, Source: "verify"}); err != nil {
		t.Fatal(err)
	}
	g := s.guard()
	j := s.janitor(g)
	res := j.Tick(context.Background())
	if res.Before.UsedPct < 90 {
		t.Fatalf("setup: %.1f%%", res.Before.UsedPct)
	}
	// 18800 -> app1 18300 (91.5) -> app2 17800 (89) -> app3 17300 (86.5 < 88): stop; ciphertext and audit copies untouched
	if got := names(res.AppDeleted); got != "app-2026-09-01T00-00-00.000.log.gz,app-2026-09-15T00-00-00.000.log.gz,app-2026-09-30T00-00-00.000.log" {
		t.Fatalf("app deleted (oldest first): %s", got)
	}
	if s.purged != 0 || len(res.AuditDeleted) != 0 {
		t.Fatalf("must stop as soon as below limit-2: purged=%d audit=%v", s.purged, res.AuditDeleted)
	}
	if res.After.UsedPct >= 88 || res.Blocked {
		t.Fatalf("after: %+v", res.After)
	}
	for _, live := range []string{"app.log", "audit.jsonl"} {
		if _, err := os.Stat(filepath.Join(s.dir, live)); err != nil {
			t.Fatalf("live file %s was deleted", live)
		}
	}
	if err := g.Admit(10); err != nil {
		t.Fatalf("below the limit uploads are admitted: %v", err)
	}
}

func TestJanitorEscalatesToTerminalTicketsThenAuditCopies(t *testing.T) {
	s := newSim(t, 14500)
	s.file("app-2026-09-01T00-00-00.000.log.gz", 500, 30*day)
	s.purgeable = 1000
	s.file("audit-2026-05-01T00-00-00.000.jsonl.gz", 1000, 150*day)
	s.file("audit-2026-06-01T00-00-00.000.jsonl.gz", 1000, 120*day)
	s.file("audit-2026-09-20T00-00-00.000.jsonl.gz", 1000, 12*day) // young: must survive
	// 14500+500+1000+3000 = 19000 = 95%
	_ = logsink.WriteMarker(s.dir, logsink.Marker{At: s.now.Add(-time.Hour), OK: true, ThroughSeq: 9, Source: "export"})
	res := s.janitor(s.guard()).Tick(context.Background())
	// app: 18500 (92.5) ; purge: 17500 (87.5 < 88) -> stop
	if names(res.AppDeleted) == "" || s.purged != 1 || len(res.AuditDeleted) != 0 {
		t.Fatalf("expected app then purge only: %+v purged=%d", res, s.purged)
	}

	s = newSim(t, 16000)
	s.purgeable = 0
	s.file("audit-2026-05-01T00-00-00.000.jsonl.gz", 1000, 150*day)
	s.file("audit-2026-06-01T00-00-00.000.jsonl.gz", 1000, 120*day)
	s.file("audit-2026-09-20T00-00-00.000.jsonl.gz", 1000, 12*day)
	// 16000 + 3000 = 19000 = 95%; only old+verified copies may go: 18000 (90) still >= limit, 17000 (85) done
	_ = logsink.WriteMarker(s.dir, logsink.Marker{At: s.now.Add(-time.Hour), OK: true, ThroughSeq: 9, Source: "verify"})
	res = s.janitor(s.guard()).Tick(context.Background())
	if got := names(res.AuditDeleted); got != "audit-2026-05-01T00-00-00.000.jsonl.gz,audit-2026-06-01T00-00-00.000.jsonl.gz" {
		t.Fatalf("audit deleted: %s", got)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "audit-2026-09-20T00-00-00.000.jsonl.gz")); err != nil {
		t.Fatal("a young audit copy must never be deleted")
	}
}

func TestJanitorAuditCopiesNeedAgeAndVerification(t *testing.T) {
	setup := func() *sim {
		s := newSim(t, 15500)
		s.file("audit-2026-05-01T00-00-00.000.jsonl.gz", 2000, 150*day)
		s.file("audit-2026-09-25T00-00-00.000.jsonl.gz", 1500, 7*day)
		return s
	}
	cases := map[string]func(s *sim){
		"no marker":              func(s *sim) {},
		"marker not ok":          func(s *sim) { _ = logsink.WriteMarker(s.dir, logsink.Marker{At: s.now, OK: false}) },
		"verified before closed": func(s *sim) { _ = logsink.WriteMarker(s.dir, logsink.Marker{At: s.now.Add(-200 * day), OK: true}) },
	}
	for name, mk := range cases {
		s := setup()
		mk(s)
		res := s.janitor(s.guard()).Tick(context.Background())
		if len(res.AuditDeleted) != 0 {
			t.Errorf("%s: deleted %v", name, res.AuditDeleted)
		}
		if !res.Blocked {
			t.Errorf("%s: nothing could be freed, must be blocked: %+v", name, res.After)
		}
	}
	// the same disk with a fresh verification marker: the old copy goes, the week-old one stays
	s := setup()
	_ = logsink.WriteMarker(s.dir, logsink.Marker{At: s.now.Add(-time.Minute), OK: true, ThroughSeq: 50, Source: "verify"})
	res := s.janitor(s.guard()).Tick(context.Background())
	if names(res.AuditDeleted) != "audit-2026-05-01T00-00-00.000.jsonl.gz" || res.Blocked {
		t.Fatalf("verified old copy should be freed: %+v", res)
	}
}

func TestJanitorHysteresisAndNoAction(t *testing.T) {
	s := newSim(t, 15000)
	s.file("app-2026-09-01T00-00-00.000.log.gz", 500, 30*day)
	// 15500 = 77.5%: nothing to do
	g := s.guard()
	j := s.janitor(g)
	if res := j.Tick(context.Background()); len(res.AppDeleted) != 0 || res.Blocked || res.After.State != StateOK {
		t.Fatalf("idle: %+v", res)
	}
	// 89% is inside the hysteresis band (limit-2 .. limit): the janitor does not start deleting
	s.base = 17300 // 17800/20000 = 89%
	if res := j.Tick(context.Background()); len(res.AppDeleted) != 0 {
		t.Fatalf("must not act below the limit: %+v", res)
	}
	if st := g.Status(); st.State != StateWarn {
		t.Fatalf("89%% should be warn: %+v", st)
	}
	// at the limit it starts and keeps going until limit-2, not merely below the limit
	s.file("app-2026-09-10T00-00-00.000.log.gz", 100, 20*day)
	s.file("app-2026-09-20T00-00-00.000.log.gz", 200, 10*day)
	s.base = 17000 // 17000+500+100+200 = 17800 -> make it exactly 90%
	s.base = 17200 // 18000 = 90%
	res := j.Tick(context.Background())
	// 18000 -> 17500 (87.5%) after the first delete: already < 88, so exactly one file goes
	if len(res.AppDeleted) != 1 || res.After.UsedPct >= 88 {
		t.Fatalf("hysteresis: %+v", res)
	}
}

func TestJanitorBlocksAlertsOnceAndRecovers(t *testing.T) {
	s := newSim(t, 19000)
	s.file("app.log", 500, 0)     // live, not deletable
	s.file("audit.jsonl", 500, 0) // live, not deletable
	// 20000/20000 = 100%
	g := s.guard()
	j := s.janitor(g)
	res := j.Tick(context.Background())
	if !res.Blocked || g.Status().State != StateBlocked {
		t.Fatalf("expected blocked: %+v / %+v", res, g.Status())
	}
	err := g.Admit(1)
	var ae *apperr.Error
	if !asAppErr(err, &ae) || ae.Code != apperr.InsufficientStorage || ae.Status() != 507 {
		t.Fatalf("Admit must answer INSUFFICIENT_STORAGE/507, got %v", err)
	}
	j.Tick(context.Background())
	j.Tick(context.Background())
	if len(s.alerts) != 1 || s.alerts[0] != StateBlocked {
		t.Fatalf("one alert per episode, got %v", s.alerts)
	}
	// operator frees space elsewhere on the volume
	s.base = 5000
	j.Tick(context.Background())
	if g.Status().State == StateBlocked || g.Admit(100) != nil {
		t.Fatalf("must recover: %+v", g.Status())
	}
	if len(s.alerts) != 2 || s.alerts[1] != StateOK {
		t.Fatalf("recovery alert: %v", s.alerts)
	}
}

func asAppErr(err error, target **apperr.Error) bool {
	if e, ok := err.(*apperr.Error); ok {
		*target = e
		return true
	}
	return false
}

func TestAdmitProjectsDeclaredSize(t *testing.T) {
	s := newSim(t, 14000)
	s.total = 100000
	g := s.guard()
	g.ReserveBytes = 1000
	// 90% of 100000 = 90000; used 14000. 10% headroom check: used + size*1.1 + reserve <= limit
	if err := g.Admit(60000); err != nil { // 14000+66000+1000 = 81000
		t.Fatalf("fits: %v", err)
	}
	if err := g.Admit(69000); err == nil { // 14000+75900+1000 = 90900 > 90000
		t.Fatal("must refuse: x1.1 + reserve would pass the limit")
	}
	if err := (*Guard)(nil).Admit(1 << 40); err != nil {
		t.Fatal("nil guard admits everything")
	}
}

func TestStatRealVolume(t *testing.T) {
	u, err := Stat(t.TempDir())
	if err != nil || u.Total == 0 || u.UsedPct() <= 0 || u.UsedPct() > 100 {
		t.Fatalf("Stat: %+v %v", u, err)
	}
	// a not-yet-created storage dir is measured through its closest existing parent
	g := &Guard{LimitPct: 99.9, Paths: []string{filepath.Join(t.TempDir(), "does", "not", "exist")}}
	if st := g.Check(); st.TotalBytes == 0 || st.Error != "" {
		t.Fatalf("missing dir: %+v", st)
	}
}
