package apitest

import (
	"context"
	"encoding/base64"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func emailToken(t *testing.T, body string) string {
	t.Helper()
	start := strings.Index(body, "/api/v1/email-approval#")
	if start < 0 {
		t.Fatal("email approval link missing")
	}
	start += len("/api/v1/email-approval#")
	return body[start : start+43]
}
func TestEmailApprovalSingleUseAndConcurrentClicks(t *testing.T) {
	x := newT(t)
	p := x.toPending()
	token := emailToken(t, x.Mail.To("lead@vnpay.vn")[0].HTML)
	status(t, x.Anon("GET", "/email-approval"), 200, "link preview")
	eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "PENDING_APPROVAL", "GET cannot approve")
	origin, _ := url.Parse(x.Cfg.PublicURL)
	hdr := map[string]string{"Origin": origin.Scheme + "://" + origin.Host}
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := x.Anon("POST", "/email-approval", Opt{Body: map[string]any{"token": token}, Headers: hdr})
			results <- r.Status
		}()
	}
	wg.Wait()
	close(results)
	ok, failed := 0, 0
	for code := range results {
		if code == 200 {
			ok++
		} else if code == 403 || code == 409 {
			failed++
		} else {
			t.Fatalf("unexpected HTTP %d", code)
		}
	}
	eq(t, ok, 1, "one decision wins")
	eq(t, failed, 1, "replay refused")
	eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "APPROVED", "approved from email")
	eq(t, Scalar[int](x.Harness, "SELECT count(*)::int FROM approvals WHERE ticket_id=$1", p.TicketID), 1, "one approval row")
	eq(t, Scalar[int](x.Harness, "SELECT count(*)::int FROM audit_log WHERE action='transfer.email_approve' AND resource_id=$1", p.TicketID), 1, "email provenance audited")
	x.Work()
	if len(x.Mail.To("alice@vnpay.vn")) == 0 {
		t.Fatal("requester not notified")
	}
}
func TestEmailApprovalInvalidation(t *testing.T) {
	cases := []struct{ name, sql string }{
		{"expired", "UPDATE email_approval_links SET expires_at=now()-interval '1 second' WHERE ticket_id=$1"},
		{"leader_changed", "UPDATE tickets SET approver_id=(SELECT id FROM users WHERE email='lead2@vnpay.vn') WHERE id=$1"},
		{"inactive", "UPDATE users SET active=false WHERE id=(SELECT approver_id FROM tickets WHERE id=$1)"},
		{"permission_removed", "DELETE FROM role_assignments WHERE user_id=(SELECT approver_id FROM tickets WHERE id=$1)"},
		{"rejected", "UPDATE tickets SET status='REJECTED' WHERE id=$1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := newT(t)
			p := x.toPending()
			token := emailToken(t, x.Mail.To("lead@vnpay.vn")[0].HTML)
			x.Exec(c.sql, p.TicketID)
			if _, err := x.Deps.Tickets.ApproveFromEmail(context.Background(), token, "127.0.0.1"); err == nil {
				t.Fatal("invalidated link approved")
			}
			eq(t, Scalar[int](x.Harness, "SELECT count(*)::int FROM approvals WHERE ticket_id=$1", p.TicketID), 0, "no decision persisted")
		})
	}
	x := newT(t)
	p := x.toPending()
	token := emailToken(t, x.Mail.To("lead@vnpay.vn")[0].HTML)
	raw, _ := base64.RawURLEncoding.DecodeString(token)
	raw[0] ^= 1
	token = base64.RawURLEncoding.EncodeToString(raw)
	if _, err := x.Deps.Tickets.ApproveFromEmail(context.Background(), token, "127.0.0.1"); err == nil {
		t.Fatal("tampered token accepted")
	}
	// Expiry is bounded by the approval window.
	var expires time.Time
	x.DB.QueryRow(context.Background(), "SELECT max(expires_at) FROM email_approval_links WHERE ticket_id=$1", p.TicketID).Scan(&expires)
	if expires.After(time.Now().Add(24*time.Hour + time.Minute)) {
		t.Fatal("link lifetime exceeded")
	}
}
