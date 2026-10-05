package apitest

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/logsink"
)

func TestAuditFileSinkMirrorsTheChain(t *testing.T) {
	x := newT(t)
	dir := filepath.Join(t.TempDir(), "Tài liệu", "logs")
	w, err := logsink.NewRolling(logsink.AuditFileName, logsink.Options{Dir: dir, MaxSizeMB: 50})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	sink := &logsink.AuditSink{Q: x.DB, W: w, Dir: dir}
	sink.Init()
	ctx := context.Background()

	x.toPending()
	n1, err := sink.Flush(ctx)
	if err != nil || n1 < 5 {
		t.Fatalf("first flush: %d %v", n1, err)
	}
	if n, _ := sink.Flush(ctx); n != 0 {
		t.Fatalf("idempotent: flushed %d again", n)
	}
	x.toPending() // more events, then a "restart": a new sink instance resumes from the file/cursor without duplicates
	sink2 := &logsink.AuditSink{Q: x.DB, W: w, Dir: dir}
	sink2.Init()
	n2, err := sink2.Flush(ctx)
	if err != nil || n2 < 5 {
		t.Fatalf("second flush: %d %v", n2, err)
	}
	b, err := os.ReadFile(filepath.Join(dir, logsink.AuditFileName))
	if err != nil {
		t.Fatal(err)
	}
	v, err := audit.VerifyJSONL(bytes.NewReader(b))
	if err != nil || !v.OK || !v.AnchoredAtGenesis || v.Checked != n1+n2 {
		t.Fatalf("file verification: %+v err=%v (want %d rows)", v, err, n1+n2)
	}
	// the DB is authoritative: the file mirrors every committed row, in order
	total := Scalar[int](x.Harness, "SELECT count(*)::int FROM audit_log")
	if v.Checked != total {
		t.Fatalf("file has %d rows, db has %d", v.Checked, total)
	}
	// the cursor survives losing the cursor file (re-derived from the last line)
	_ = os.Remove(filepath.Join(dir, "audit.cursor"))
	sink3 := &logsink.AuditSink{Q: x.DB, W: w, Dir: dir}
	sink3.Init()
	if n, _ := sink3.Flush(ctx); n != 0 {
		t.Fatalf("duplicates after cursor loss: %d", n)
	}
	// a row of a rolled-back transaction never reaches the file (the sink only reads committed rows)
	err = x.DB.InTx(ctx, func(tx dbRunner) error {
		if err := audit.Write(ctx, tx, audit.Entry{ActorLabel: "ghost", Action: "ghost.rolled_back"}); err != nil {
			return err
		}
		return errRollback
	})
	if err != errRollback {
		t.Fatal(err)
	}
	if n, _ := sink3.Flush(ctx); n != 0 {
		t.Fatal("rolled back audit row leaked to the file")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, logsink.AuditFileName)); strings.Contains(string(b), "ghost.rolled_back") {
		t.Fatal("ghost row in file")
	}
	_ = time.Now
}

type dbRunner = db.Runner

var errRollback = errors.New("rollback on purpose")
