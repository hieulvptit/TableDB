package apitest

import (
	"context"
	"strings"
	"sync"
	"testing"

	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/crypto"
)

func TestAuditChain(t *testing.T) {
	p := newDB(t)
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Run("chains, redacts, detects tampering; rows are immutable", func(t *testing.T) {
		must(audit.Write(ctx, p, audit.Entry{Action: "a", Detail: map[string]any{"password": "x", "sql": "select 1"}}))
		must(audit.Write(ctx, p, audit.Entry{Action: "b", Detail: map[string]any{"n": 1}}))
		v, err := audit.Verify(ctx, p)
		must(err)
		if !v.OK {
			t.Fatalf("chain broken: %+v", v)
		}
		var pw string
		must(p.QueryRow(ctx, "SELECT detail->>'password' FROM audit_log WHERE action='a'").Scan(&pw))
		if pw != "[REDACTED]" {
			t.Fatalf("password not redacted: %q", pw)
		}
		if _, err := p.Exec(ctx, "UPDATE audit_log SET action='z'"); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("update should be refused, got %v", err)
		}
		if _, err := p.Exec(ctx, "DELETE FROM audit_log"); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("delete should be refused, got %v", err)
		}
		if _, err := p.Exec(ctx, "TRUNCATE audit_log"); err == nil {
			t.Fatal("truncate should be refused")
		}
	})
	t.Run("concurrent appends keep a valid chain", func(t *testing.T) {
		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				if err := audit.Write(ctx, p, audit.Entry{Action: "c" + string(rune('0'+i))}); err != nil {
					t.Error(err)
				}
			}(i)
		}
		wg.Wait()
		v, err := audit.Verify(ctx, p)
		must(err)
		if !v.OK || v.Checked < 12 {
			t.Fatalf("%+v", v)
		}
	})
	t.Run("a doctored row is detected", func(t *testing.T) {
		// bypass the trigger as a DBA would, then verify must flag the exact row
		must(func() error {
			_, err := p.Exec(ctx, "ALTER TABLE audit_log DISABLE TRIGGER audit_no_update")
			return err
		}())
		_, err := p.Exec(ctx, "UPDATE audit_log SET actor_label='mallory' WHERE action='b'")
		must(err)
		v, err := audit.Verify(ctx, p)
		must(err)
		if v.OK || v.BrokenAtSeq == 0 {
			t.Fatalf("tampering not detected: %+v", v)
		}
	})
}

func TestSecrets(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	kp, err := crypto.NewStaticKeyProvider(b64(key))
	if err != nil {
		t.Fatal(err)
	}
	blob, err := crypto.EncryptSecret(kp, "tok-123", "user:1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(blob, "tok-123") {
		t.Fatal("plaintext leaked into blob")
	}
	got, err := crypto.DecryptSecret(kp, blob, "user:1")
	if err != nil || got != "tok-123" {
		t.Fatalf("round trip: %q %v", got, err)
	}
	if _, err := crypto.DecryptSecret(kp, blob, "user:2"); err == nil {
		t.Fatal("context binding not enforced")
	}
	if _, err := crypto.NewStaticKeyProvider(b64(key[:16])); err == nil {
		t.Fatal("short key must be refused")
	}
}
