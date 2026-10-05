package tickets

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"time"
	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/shared"
)

// NewEmailApprovalLink mints an approval-only bearer capability. Only its hash
// is persisted; the secret lives in the URL fragment, never the HTTP URL/logs.
func (s *Service) NewEmailApprovalLink(ctx context.Context, id, approver string) (string, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(secret[:])
	err := s.DB.InTx(ctx, func(tx db.Runner) error {
		t, err := loadTicket(ctx, tx, id, true)
		if err != nil {
			return err
		}
		now := s.Now()
		if t.Status != shared.StatusPendingApproval || t.ApproverID != approver || t.ExpiresAt != nil && !t.ExpiresAt.After(now) {
			return apperr.Conflict("request is no longer pending approval")
		}
		exp := now.Add(24 * time.Hour)
		if t.ExpiresAt != nil && t.ExpiresAt.Before(exp) {
			exp = *t.ExpiresAt
		}
		_, err = tx.Exec(ctx, "INSERT INTO email_approval_links (token_hash,ticket_id,approver_id,expires_at) VALUES ($1,$2,$3,$4)", crypto.Sha256HexString(token), id, approver, exp)
		return err
	})
	if err != nil {
		return "", err
	}
	return strings.TrimRight(s.Cfg.PublicURL, "/") + "/api/v1/email-approval#" + token, nil
}

func validEmailApprovalToken(token string) bool {
	if len(token) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == token
}

// ApproveFromEmail consumes the capability and records the normal decision in
// one transaction. Current approver, permissions, expiry and status are checked
// again, so reassignment, revocation or a previous decision invalidate the link.
func (s *Service) ApproveFromEmail(ctx context.Context, token, ip string) (*TicketView, error) {
	invalid := func() error { return apperr.NewForbidden("approval link is invalid, expired or already used") }
	if !validEmailApprovalToken(token) {
		return nil, invalid()
	}
	return db.Tx(ctx, s.DB, func(tx db.Runner) (*TicketView, error) {
		hash := crypto.Sha256HexString(token)
		var id string
		if err := tx.QueryRow(ctx, "SELECT ticket_id::text FROM email_approval_links WHERE token_hash=$1", hash).Scan(&id); err != nil {
			if db.IsNoRows(err) {
				return nil, invalid()
			}
			return nil, err
		}
		// All decision paths lock the ticket first, including concurrent email clicks.
		ticket, err := loadTicket(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		var approver string
		var expires time.Time
		var used *time.Time
		if err := tx.QueryRow(ctx, "SELECT approver_id::text,expires_at,used_at FROM email_approval_links WHERE token_hash=$1 FOR UPDATE", hash).Scan(&approver, &expires, &used); err != nil {
			return nil, err
		}
		if used != nil || !expires.After(s.Now()) || ticket.ApproverID != approver {
			return nil, invalid()
		}
		principal, err := auth.LoadPrincipal(ctx, tx, approver)
		if err != nil {
			return nil, err
		}
		if principal == nil || !shared.HasPermission(principal, "transfer:approve") {
			return nil, invalid()
		}
		var email, name string
		if err := tx.QueryRow(ctx, "SELECT email,name FROM users WHERE id=$1", approver).Scan(&email, &name); err != nil {
			return nil, err
		}
		caller := &auth.Ctx{Principal: *principal, Email: email, Name: name, Kind: shared.ClientWeb}
		scoped := *s
		scoped.DB = tx
		view, err := scoped.Decide(ctx, caller, id, "approve", nil, ip)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, "UPDATE email_approval_links SET used_at=$2 WHERE ticket_id=$1 AND used_at IS NULL", id, s.Now()); err != nil {
			return nil, err
		}
		if err := scoped.audT(ctx, tx, caller, "transfer.email_approve", ticket, ip, map[string]any{"authentication": "single_use_email_link", "decision": "approve"}); err != nil {
			return nil, err
		}
		return view, nil
	})
}
