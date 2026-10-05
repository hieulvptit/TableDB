package migrate_test

import (
	"context"
	"os"
	"testing"

	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/migrate"
)

var pgURL string

func TestMain(m *testing.M) {
	e, err := db.StartEmbedded("", nil)
	if err != nil {
		panic(err)
	}
	pgURL = e.URL
	code := m.Run()
	_ = e.Stop()
	os.Exit(code)
}

func TestSplitAndRun(t *testing.T) {
	got := migrate.SplitStatements("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 'a;b'; -- c;\nSELECT 2")
	if len(got) != 3 {
		t.Fatalf("want 3 statements, got %d: %q", len(got), got)
	}
	ctx := context.Background()
	p, err := db.Open(ctx, pgURL)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	applied, err := migrate.Run(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 8 {
		t.Fatalf("applied %v", applied)
	}
	again, err := migrate.Run(ctx, p)
	if err != nil || len(again) != 0 {
		t.Fatalf("second run applied %v err %v", again, err)
	}
}
