package logsink

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/db"
)

// AuditSink copies committed audit rows to an append-only JSONL file (each line = the full row incl. seq, prevHash, hash, so
// the file verifies on its own with `auditverify`). It tails the table rather than hooking Write, so rows of rolled-back
// transactions can never appear and a crash loses nothing: the cursor is re-derived from the file on start. The DB remains
// the source of truth.
type AuditSink struct {
	Q        db.Querier
	W        io.Writer
	Dir      string
	Interval time.Duration
	Log      *slog.Logger
	last     int64
}

func (s *AuditSink) cursorPath() string { return filepath.Join(s.Dir, cursorName) }

// Init restores the cursor: the larger of the cursor file and the last line of the live file.
func (s *AuditSink) Init() {
	if b, err := os.ReadFile(s.cursorPath()); err == nil {
		if n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil {
			s.last = n
		}
	}
	if n := lastSeqInFile(filepath.Join(s.Dir, AuditFileName)); n > s.last {
		s.last = n
	}
}

func lastSeqInFile(path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return 0
	}
	n := st.Size()
	if n > 1<<20 {
		n = 1 << 20
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, st.Size()-n); err != nil && err != io.EOF {
		return 0
	}
	buf = bytes.TrimRight(buf, "\r\n")
	if i := bytes.LastIndexByte(buf, '\n'); i >= 0 {
		buf = buf[i+1:]
	}
	var r struct {
		Seq int64 `json:"seq"`
	}
	if json.Unmarshal(buf, &r) != nil {
		return 0
	}
	return r.Seq
}

// Flush appends all new committed rows; returns how many.
func (s *AuditSink) Flush(ctx context.Context) (int, error) {
	n := 0
	for {
		rows, err := audit.List(ctx, s.Q, audit.Filter{MinSeq: s.last + 1}, 500, false)
		if err != nil {
			return n, err
		}
		if len(rows) == 0 {
			return n, nil
		}
		for _, r := range rows {
			b, err := json.Marshal(r)
			if err != nil {
				return n, err
			}
			if _, err := s.W.Write(append(b, '\n')); err != nil {
				return n, err
			}
			s.last = r.Seq
			n++
		}
		if err := writeAtomic(s.cursorPath(), []byte(strconv.FormatInt(s.last, 10))); err != nil {
			return n, err
		}
		if len(rows) < 500 {
			return n, nil
		}
	}
}

// Run flushes every Interval until ctx is done (one last flush on the way out).
func (s *AuditSink) Run(ctx context.Context) {
	if s.Interval <= 0 {
		s.Interval = time.Second
	}
	s.Init()
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		if _, err := s.Flush(ctx); err != nil && ctx.Err() == nil && s.Log != nil {
			s.Log.Error("audit file sink", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, _ = s.Flush(fctx)
			cancel()
			return
		case <-t.C:
		}
	}
}
