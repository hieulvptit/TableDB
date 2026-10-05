package tickets

import (
	"context"
	"encoding/base64"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"strings"
	"testing"
	"time"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
)

type capabilityRow func(...any) error

func (r capabilityRow) Scan(dest ...any) error { return r(dest...) }

type deniedCapabilityDB struct {
	hash, approver string
	expires        time.Time
	used           *time.Time
	queries        int
	committed      bool
}

func (d *deniedCapabilityDB) InTx(ctx context.Context, fn func(db.Runner) error) error {
	err := fn(d)
	d.committed = err == nil
	return err
}
func (d *deniedCapabilityDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("invalid link must not mutate database")
}
func (d *deniedCapabilityDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("invalid link must not load permissions or decisions")
}
func (d *deniedCapabilityDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	d.queries++
	if strings.Contains(sql, "FROM tickets t") {
		return capabilityRow(func(dest ...any) error {
			*dest[0].(*string) = "11111111-1111-1111-1111-111111111111"
			*dest[3].(*string) = "leader"
			*dest[9].(*string) = "PENDING_APPROVAL"
			return nil
		})
	}
	if args[0] != d.hash {
		return capabilityRow(func(...any) error { return pgx.ErrNoRows })
	}
	if strings.Contains(sql, "FOR UPDATE") {
		return capabilityRow(func(dest ...any) error {
			*dest[0].(*string) = d.approver
			*dest[1].(*time.Time) = d.expires
			*dest[2].(**time.Time) = d.used
			return nil
		})
	}
	return capabilityRow(func(dest ...any) error { *dest[0].(*string) = "11111111-1111-1111-1111-111111111111"; return nil })
}
func TestEmailApprovalInvalidLinksNeverRecordDecision(t *testing.T) {
	now := time.Now()
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	used := now
	cases := []struct {
		name, token, approver string
		expires               time.Time
		used                  *time.Time
	}{
		{"expired", token, "leader", now.Add(-time.Second), nil},
		{"used", token, "leader", now.Add(time.Hour), &used},
		{"reassigned", token, "former-leader", now.Add(time.Hour), nil},
		{"unknown", base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("x", 32))), "leader", now.Add(time.Hour), nil},
		{"malformed", "short", "leader", now.Add(time.Hour), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q := &deniedCapabilityDB{hash: crypto.Sha256HexString(token), approver: c.approver, expires: c.expires, used: c.used}
			s := Service{DB: q, Now: func() time.Time { return now }}
			view, err := s.ApproveFromEmail(context.Background(), c.token, "127.0.0.1")
			if err == nil || view != nil || q.committed {
				t.Fatal("invalid link was accepted")
			}
			if c.name == "malformed" && q.queries != 0 {
				t.Fatal("malformed token reached database")
			}
		})
	}
	// Alternate base64 encodings of the same bytes must not become capabilities.
	for _, bad := range []string{token + "=", strings.Repeat("A", 42), strings.Repeat("!", 43), fmt.Sprintf("%sB", token[:42])} {
		if validEmailApprovalToken(bad) {
			t.Fatalf("non-canonical token accepted: %q", bad)
		}
	}
}
