package logsink

import (
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func TestRollingRotatesAndCompresses(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Tài liệu", "logs") // spaces + non-ASCII, like a Windows Documents folder
	w, err := NewRolling(AppLogName, Options{Dir: dir, MaxSizeMB: 1, MaxBackups: 5})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	line := []byte(strings.Repeat("x", 1023) + "\n")
	for i := 0; i < 3*1024+10; i++ { // ~3 MB
		if _, err := w.Write(line); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, "compressed segments", func() bool {
		segs, _ := Segments(dir, AppLogName)
		n := 0
		for _, s := range segs {
			if strings.HasSuffix(s.Path, ".gz") {
				n++
			}
		}
		return n >= 2 && n == len(segs) // compression of every closed segment finished
	})
	segs, _ := Segments(dir, AppLogName)
	for _, s := range segs {
		if filepath.Base(s.Path) == AppLogName {
			t.Fatal("live file must not be listed as a segment")
		}
		if !strings.HasPrefix(filepath.Base(s.Path), "app-") {
			t.Fatalf("unexpected segment name %s", s.Path)
		}
	}
	// the live file is still being written and is at most MaxSize
	if st, err := os.Stat(filepath.Join(dir, AppLogName)); err != nil || st.Size() > 1<<20 {
		t.Fatalf("live file: %v %v", st, err)
	}
	// segments are valid gzip with the original content
	for _, s := range segs {
		if !strings.HasSuffix(s.Path, ".gz") {
			continue
		}
		f, _ := os.Open(s.Path)
		zr, err := gzip.NewReader(f)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(zr)
		f.Close()
		if !bytes.HasPrefix(b, line) {
			t.Fatal("segment content")
		}
	}
}

func TestRollingMaxBackups(t *testing.T) {
	dir := t.TempDir()
	w, _ := NewRolling("app.log", Options{Dir: dir, MaxSizeMB: 1, MaxBackups: 1})
	defer w.Close()
	line := []byte(strings.Repeat("y", 1023) + "\n")
	for i := 0; i < 4*1024+10; i++ {
		_, _ = w.Write(line)
	}
	waitFor(t, "backups pruned to 1 and compressed", func() bool {
		segs, _ := Segments(dir, "app.log")
		return len(segs) == 1 && strings.HasSuffix(segs[0].Path, ".gz")
	})
}

func TestDailyRotation(t *testing.T) {
	dir := t.TempDir()
	w, err := NewRolling("app.log", Options{Dir: dir, MaxSizeMB: 50, Daily: true})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := w.Write([]byte("yesterday\n")); err != nil {
		t.Fatal(err)
	}
	w.last = time.Now().AddDate(0, 0, -1).Format("2006-01-02") // the date changed since the last write
	if _, err := w.Write([]byte("today\n")); err != nil {
		t.Fatal(err)
	}
	// Close only closes the live file; wait for background compression to finish
	// (the source segment is removed last) before TempDir cleanup can run.
	waitFor(t, "compressed daily segment", func() bool {
		s, err := Segments(dir, "app.log")
		return err == nil && len(s) == 1 && strings.HasSuffix(s[0].Path, ".gz")
	})
	b, err := os.ReadFile(filepath.Join(dir, "app.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "today\n" {
		t.Fatalf("live file after daily rotation: %q", b)
	}
}

func TestSegmentsSeparateAppAndAudit(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"app.log", "app-2026-01-01T00-00-00.000.log.gz", "app-2026-01-02T00-00-00.000.log", "audit.jsonl", "audit-2026-01-01T00-00-00.000.jsonl.gz", "audit.verified.json", "audit.cursor", "other.txt"} {
		_ = os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o640)
	}
	app, _ := Segments(dir, AppLogName)
	au, _ := Segments(dir, AuditFileName)
	if len(app) != 2 || len(au) != 1 {
		t.Fatalf("app=%d audit=%d", len(app), len(au))
	}
	if s, err := Segments(filepath.Join(dir, "missing"), AppLogName); err != nil || s != nil {
		t.Fatalf("missing dir: %v %v", s, err)
	}
}

func TestMarkerRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new", "logs")
	if _, ok := ReadMarker(dir); ok {
		t.Fatal("no marker yet")
	}
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := WriteMarker(dir, Marker{At: at, OK: true, ThroughSeq: 42, Source: "verify"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteMarker(dir, Marker{At: at.Add(time.Hour), OK: true, ThroughSeq: 43, Source: "export"}); err != nil { // overwrite works (Windows rename semantics)
		t.Fatal(err)
	}
	m, ok := ReadMarker(dir)
	if !ok || m.ThroughSeq != 43 || m.Source != "export" || !m.OK {
		t.Fatalf("marker %+v", m)
	}
}
