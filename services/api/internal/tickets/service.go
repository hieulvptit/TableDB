package tickets

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/hrm"
	"vnpay/tabledb-api/internal/inspect"
	"vnpay/tabledb-api/internal/mail"
	"vnpay/tabledb-api/internal/outbox"
	"vnpay/tabledb-api/internal/pii"
	"vnpay/tabledb-api/internal/scan"
	"vnpay/tabledb-api/internal/shared"
	"vnpay/tabledb-api/internal/store"
)

type Service struct {
	Cfg     *config.Config
	DB      db.Runner
	Keys    crypto.KeyProvider
	Store   store.FileStore
	Scanner scan.Scanner
	PII     pii.Checker
	Mailer  mail.Mailer
	HRM     *hrm.Client
	Now     func() time.Time
	// Disk is the admission control for new bytes (nil = unlimited). *diskguard.Guard in production.
	Disk Admitter
}

// Admitter refuses new uploads when the server disk budget is exhausted (returns an INSUFFICIENT_STORAGE error).
type Admitter interface{ Admit(size int64) error }

func (s *Service) admit(size int64) error {
	if s.Disk == nil {
		return nil
	}
	return s.Disk.Admit(size)
}

func (s *Service) aud(ctx context.Context, q db.Runner, a *auth.Ctx, action, resType, resID, ip string, detail map[string]any) error {
	return audit.Write(ctx, q, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: action, ResourceType: resType, ResourceID: resID, IP: ip, Detail: detail})
}

func (s *Service) sysAudit(ctx context.Context, q db.Runner, action, resID string, detail map[string]any) error {
	return audit.Write(ctx, q, audit.Entry{ActorLabel: "system", Action: action, ResourceType: "ticket", ResourceID: resID, Detail: detail})
}

func (s *Service) queueMail(ctx context.Context, q db.Querier, kind, id, extra string) error {
	return outbox.Enqueue(ctx, q, "email."+kind, map[string]any{"ticketId": id}, outbox.EnqueueOpts{DedupeKey: "email." + kind + ":" + id + extra, MaxAttempts: 12})
}

// deleteParts removes the ciphertext of a ticket and reports how many parts / bytes were on disk.
func (s *Service) deleteParts(ctx context.Context, t *Ticket) (int, int64, error) {
	var parts int
	var bytes int64
	_ = s.DB.QueryRow(ctx, "SELECT count(*)::int, COALESCE(sum(size),0)::bigint FROM upload_parts WHERE ticket_id=$1", t.ID).Scan(&parts, &bytes)
	for n := 1; n <= t.TotalParts; n++ {
		_ = s.Store.Delete(partKey(t.ID, n))
	}
	_, err := s.DB.Exec(ctx, "DELETE FROM upload_parts WHERE ticket_id=$1", t.ID)
	return parts, bytes, err
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

var badName = regexp.MustCompile(`^[^\\/:*?"<>|\x00]+$`)

type CreateResult struct {
	Ticket     TicketView `json:"ticket"`
	PartBytes  int        `json:"partBytes"`
	TotalParts int        `json:"totalParts"`
}

// CreateTicket validates the request and creates the ticket in UPLOADING. The direction comes from the session kind.
func (s *Service) CreateTicket(ctx context.Context, a *auth.Ctx, b *shared.UploadInit, ip string) (*CreateResult, error) {
	if !shared.HasPermission(&a.Principal, "transfer:create") {
		return nil, apperr.NewForbidden("missing transfer:create")
	}
	ext := ""
	if strings.Contains(b.FileName, ".") {
		parts := strings.Split(b.FileName, ".")
		ext = strings.ToLower(parts[len(parts)-1])
	}
	if !badName.MatchString(b.FileName) || strings.Contains(b.FileName, "..") || hasControl(b.FileName) {
		return nil, apperr.Validation("invalid file name")
	}
	if len(s.Cfg.AllowedExtensions) > 0 {
		ok := false
		for _, e := range s.Cfg.AllowedExtensions {
			if e == ext {
				ok = true
			}
		}
		if !ok {
			return nil, apperr.Validation(fmt.Sprintf("file type .%s is not allowed", ext))
		}
	}
	if b.Size > s.Cfg.MaxUploadBytes {
		return nil, apperr.Validation("file exceeds size limit")
	}
	if err := s.admit(b.Size); err != nil {
		return nil, err
	}
	if strings.EqualFold(b.ApproverID, a.Principal.ID) {
		return nil, apperr.Validation("you cannot choose yourself as approver")
	}
	if s.Cfg.HRMConfigured() {
		// approver must be one of the requester's managers in HRM (re-checked server-side, not trusted from the client)
		var email string
		err := s.DB.QueryRow(ctx, `SELECT lower(u.email) FROM users u JOIN role_assignments ra ON ra.user_id=u.id AND ra.role='leader' WHERE u.id=$1 AND u.active`, b.ApproverID).Scan(&email)
		if err != nil && !db.IsNoRows(err) {
			return nil, err
		}
		ok := false
		if err == nil {
			ms, err := s.HRM.ManagersOf(ctx, a.Email)
			if err != nil {
				return nil, err
			}
			for _, m := range ms {
				if m.Email == email {
					ok = true
				}
			}
		}
		if !ok {
			return nil, apperr.Validation("approver is not one of your managers in HRM")
		}
	} else {
		var id string
		err := s.DB.QueryRow(ctx, `SELECT u.id::text FROM leaders l JOIN users u ON u.id=l.user_id JOIN role_assignments ra ON ra.user_id=u.id AND ra.role='leader'
			WHERE l.user_id=$1 AND l.enabled AND u.active`, b.ApproverID).Scan(&id)
		if err != nil {
			if db.IsNoRows(err) {
				return nil, apperr.Validation("approver is not an active leader in the configured list")
			}
			return nil, err
		}
	}
	recipients := dedupe(b.RecipientIDs)
	if len(recipients) > 0 {
		var n int
		if err := s.DB.QueryRow(ctx, "SELECT count(*)::int FROM users WHERE id = ANY($1::uuid[]) AND active", recipients).Scan(&n); err != nil {
			return nil, err
		}
		if n != len(recipients) {
			return nil, apperr.Validation("unknown recipient")
		}
	}
	partBytes := s.Cfg.PartBytes
	totalParts := int((b.Size + partBytes - 1) / partBytes)
	dekWrapped, err := s.Keys.Wrap(randomBytes(32))
	if err != nil {
		return nil, err
	}
	direction := shared.DirectionForUploader(a.Kind)
	return db.Tx(ctx, s.DB, func(t db.Runner) (*CreateResult, error) {
		var seq int
		if err := t.QueryRow(ctx, "SELECT nextval('ticket_code_seq')::int").Scan(&seq); err != nil {
			return nil, err
		}
		code := fmt.Sprintf("TF-%d-%06d", s.Now().UTC().Year(), seq)
		var id string
		meta := metaOf(ctx)
		var cip, cua *string
		if meta.IP != "" {
			cip = &meta.IP
		} else if ip != "" {
			cip = &ip
		}
		if meta.UserAgent != "" {
			cua = &meta.UserAgent
		}
		err := t.QueryRow(ctx, `INSERT INTO tickets (code, requester_id, approver_id, recipient_ids, file_name, size, sha256, purpose, status, part_bytes, total_parts, dek_wrapped, max_downloads, direction, client_ip, client_user_agent, client_kind)
			VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,'UPLOADING',$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id::text`,
			code, a.Principal.ID, b.ApproverID, recipients, b.FileName, b.Size, b.SHA256, b.Purpose, int(partBytes), totalParts, dekWrapped, s.Cfg.MaxDownloads, string(direction), cip, cua, string(a.Kind)).Scan(&id)
		if err != nil {
			return nil, err
		}
		row, err := loadTicket(ctx, t, id, false)
		if err != nil {
			return nil, err
		}
		if err := event(ctx, t, id, a.Principal.ID, "created", map[string]any{"fileName": b.FileName, "size": b.Size, "direction": direction}); err != nil {
			return nil, err
		}
		if err := s.audT(ctx, t, a, "transfer.create", row, ip, map[string]any{"code": code, "size": b.Size, "sha256": b.SHA256, "approverId": b.ApproverID, "direction": direction,
			"partBytes": partBytes, "totalParts": totalParts, "maxDownloads": s.Cfg.MaxDownloads, "ticketTtlHours": s.Cfg.TicketTTLHours}); err != nil {
			return nil, err
		}
		return &CreateResult{Ticket: row.View(), PartBytes: int(partBytes), TotalParts: totalParts}, nil
	})
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		l := strings.ToLower(s)
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

func sha256Hex(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

type PartResult struct {
	N         int  `json:"n"`
	Duplicate bool `json:"duplicate"`
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Service) PutPart(ctx context.Context, a *auth.Ctx, id string, n int, body []byte, claimedSha string) (*PartResult, error) {
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return nil, err
	}
	if t.RequesterID != a.Principal.ID {
		return nil, apperr.NotFound("ticket not found")
	}
	if t.Status != shared.StatusUploading {
		return nil, apperr.Conflict("ticket is " + string(t.Status))
	}
	if n < 1 || n > t.TotalParts {
		return nil, apperr.Validation("part number out of range")
	}
	expected := int64(t.PartBytes)
	if n >= t.TotalParts {
		expected = t.Size - int64(t.PartBytes)*int64(t.TotalParts-1)
	}
	if int64(len(body)) != expected {
		return nil, apperr.Validation(fmt.Sprintf("part %d must be %d bytes", n, expected))
	}
	actual := sha256Hex(body)
	if !hex64.MatchString(claimedSha) || actual != claimedSha {
		return nil, apperr.Validation("part checksum mismatch")
	}
	var existing string
	err = s.DB.QueryRow(ctx, "SELECT sha256 FROM upload_parts WHERE ticket_id=$1 AND n=$2", id, n).Scan(&existing)
	if err == nil {
		if existing == actual {
			return &PartResult{N: n, Duplicate: true}, nil
		}
		return nil, apperr.Conflict("part already uploaded with different content")
	} else if !db.IsNoRows(err) {
		return nil, err
	}
	if err := s.admit(int64(len(body))); err != nil {
		return nil, err
	}
	dek, err := s.Keys.Unwrap(t.DekWrapped)
	if err != nil {
		return nil, err
	}
	ct, err := crypto.SealBuffer(dek, body, partAAD(id, n))
	if err != nil {
		return nil, err
	}
	if err := s.Store.Put(partKey(id, n), ct); err != nil {
		return nil, err
	}
	if _, err := s.DB.Exec(ctx, "INSERT INTO upload_parts (ticket_id, n, size, sha256, storage_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", id, n, len(body), actual, partKey(id, n)); err != nil {
		return nil, err
	}
	if tag, err := s.DB.Exec(ctx, "UPDATE tickets SET upload_started_at=now() WHERE id=$1 AND upload_started_at IS NULL", id); err == nil && tag.RowsAffected() == 1 {
		_ = s.audT(ctx, s.DB, a, "transfer.upload_started", t, "", map[string]any{"partBytes": t.PartBytes, "totalParts": t.TotalParts})
	}
	return &PartResult{N: n}, nil
}

func (s *Service) receivedParts(ctx context.Context, q db.Querier, id string) ([]int, error) {
	rows, err := q.Query(ctx, "SELECT n FROM upload_parts WHERE ticket_id=$1 ORDER BY n", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int{}
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

type CompleteResult struct {
	Ticket TicketView `json:"ticket"`
	Replay bool       `json:"replay"`
}

func (s *Service) CompleteUpload(ctx context.Context, a *auth.Ctx, id, idemKey, ip string) (*CompleteResult, error) {
	if l := len(idemKey); l < 8 || l > 128 {
		return nil, apperr.Validation("Idempotency-Key header required (8-128 chars)")
	}
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return nil, err
	}
	if t.RequesterID != a.Principal.ID {
		return nil, apperr.NotFound("ticket not found")
	}
	if t.Status != shared.StatusUploading {
		if t.CompleteIdemKey != nil && *t.CompleteIdemKey == idemKey {
			return &CompleteResult{Ticket: t.View(), Replay: true}, nil
		}
		return nil, apperr.Conflict("ticket is " + string(t.Status))
	}
	have, err := s.receivedParts(ctx, s.DB, id)
	if err != nil {
		return nil, err
	}
	got := map[int]bool{}
	for _, n := range have {
		got[n] = true
	}
	missing := []int{}
	for n := 1; n <= t.TotalParts; n++ {
		if !got[n] {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		return nil, apperr.ConflictD("parts missing", map[string]any{"missing": missing})
	}
	// whole-file checksum over authenticated plaintext (GCM verifies each part; AAD binds ticket+index)
	rd, err := s.plaintext(t)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	total, err := io.Copy(h, rd)
	if err != nil {
		return nil, err
	}
	if hex.EncodeToString(h.Sum(nil)) != t.SHA256 || total != t.Size {
		return nil, apperr.Validation("file checksum mismatch")
	}
	return db.Tx(ctx, s.DB, func(tx db.Runner) (*CompleteResult, error) {
		cur, err := loadTicket(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		if cur.Status != shared.StatusUploading {
			if cur.CompleteIdemKey != nil && *cur.CompleteIdemKey == idemKey {
				return &CompleteResult{Ticket: cur.View(), Replay: true}, nil
			}
			return nil, apperr.Conflict("ticket is " + string(cur.Status))
		}
		completedAt := s.Now()
		if err := setStatus(ctx, tx, id, shared.StatusUploading, shared.StatusScanning, setCol{"complete_idem_key", idemKey}, setCol{"upload_completed_at", completedAt}); err != nil {
			return nil, err
		}
		cur.UploadCompletedAt = &completedAt
		if err := event(ctx, tx, id, a.Principal.ID, "upload.completed", map[string]any{"parts": cur.TotalParts}); err != nil {
			return nil, err
		}
		if err := s.audT(ctx, tx, a, "transfer.upload_complete", cur, ip, merge(uploadTiming(cur), map[string]any{"sha256": cur.SHA256, "size": cur.Size, "actualSize": total, "sha256Verified": true})); err != nil {
			return nil, err
		}
		if err := outbox.Enqueue(ctx, tx, "scan", map[string]any{"ticketId": id}, outbox.EnqueueOpts{DedupeKey: "scan:" + id, MaxAttempts: 30}); err != nil {
			return nil, err
		}
		cur.Status = shared.StatusScanning
		cur.CompleteIdemKey = &idemKey
		return &CompleteResult{Ticket: cur.View()}, nil
	})
}

func (s *Service) AbortUpload(ctx context.Context, a *auth.Ctx, id, ip string) error {
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return err
	}
	if t.RequesterID != a.Principal.ID {
		return apperr.NotFound("ticket not found")
	}
	received, _ := s.receivedParts(ctx, s.DB, id)
	err = s.DB.InTx(ctx, func(tx db.Runner) error {
		if err := setStatus(ctx, tx, id, t.Status, shared.StatusAborted); err != nil {
			return err
		}
		if err := event(ctx, tx, id, a.Principal.ID, "upload.aborted", nil); err != nil {
			return err
		}
		return s.audT(ctx, tx, a, "transfer.abort", t, ip, merge(uploadTiming(t), map[string]any{"fromStatus": string(t.Status), "partsReceived": len(received)}))
	})
	if err != nil {
		return err
	}
	_, _, err = s.deleteParts(ctx, t)
	return err
}

// ---- decisions

func (s *Service) Decide(ctx context.Context, a *auth.Ctx, id, decision string, reason *string, ip string) (*TicketView, error) {
	now := s.Now()
	return db.Tx(ctx, s.DB, func(tx db.Runner) (*TicketView, error) {
		t, err := loadTicket(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		dg, err := delegationsFor(ctx, tx, t.ApproverID)
		if err != nil {
			return nil, err
		}
		// hide existence from people with no relation to the ticket
		if !shared.CanView(a.Principal, t.Ref(), dg, now).Allow {
			return nil, apperr.NotFound("ticket not found")
		}
		if d := shared.CanApprove(a.Principal, t.Ref(), dg, now); !d.Allow {
			return nil, apperr.NewForbidden(d.Reason)
		}
		var onBehalf *string
		if a.Principal.ID != t.ApproverID {
			ob := t.ApproverID
			onBehalf = &ob
		}
		tag, err := tx.Exec(ctx, "INSERT INTO approvals (ticket_id, decided_by, on_behalf_of, decision, reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (ticket_id) DO NOTHING", id, a.Principal.ID, onBehalf, decision, reason)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 0 {
			return nil, apperr.Conflict("a decision has already been recorded")
		}
		if decision == "approve" {
			exp := now.Add(time.Duration(s.Cfg.TicketTTLHours * float64(time.Hour)))
			if err := setStatus(ctx, tx, id, shared.StatusPendingApproval, shared.StatusApproved, setCol{"expires_at", exp}); err != nil {
				return nil, err
			}
		} else if err := setStatus(ctx, tx, id, shared.StatusPendingApproval, shared.StatusRejected, setCol{"decision_reason", reason}); err != nil {
			return nil, err
		}
		var onb any
		if onBehalf != nil {
			onb = *onBehalf
		}
		var rs any
		if reason != nil {
			rs = *reason
		}
		if err := event(ctx, tx, id, a.Principal.ID, "decision."+decision, map[string]any{"reason": rs, "onBehalfOf": onb}); err != nil {
			return nil, err
		}
		ex := map[string]any{"reason": rs, "onBehalfOf": onb, "sha256": t.SHA256, "decision": decision, "decidedBy": s.person(ctx, tx, a.Principal.ID),
			"decidedAt": isoMillis(now), "fromStatus": string(t.Status)}
		if onBehalf != nil {
			ex["onBehalfOfUser"] = s.person(ctx, tx, *onBehalf)
		}
		if t.ScanResult != nil {
			ex["scanResult"] = scanKind(*t.ScanResult)
		}
		if err := s.audT(ctx, tx, a, "transfer."+decision, t, ip, ex); err != nil {
			return nil, err
		}
		if err := s.queueMail(ctx, tx, "decision", id, ""); err != nil {
			return nil, err
		}
		fresh, err := loadTicket(ctx, tx, id, false)
		if err != nil {
			return nil, err
		}
		if decision == "reject" { // rejected content is never downloadable: delete it
			if err := outbox.Enqueue(ctx, tx, "purge", map[string]any{"ticketId": id}, outbox.EnqueueOpts{DedupeKey: "purge:" + id}); err != nil {
				return nil, err
			}
		}
		v := fresh.View()
		return &v, nil
	})
}

func (s *Service) Revoke(ctx context.Context, a *auth.Ctx, id string, reason *string, ip string) (*TicketView, error) {
	return db.Tx(ctx, s.DB, func(tx db.Runner) (*TicketView, error) {
		t, err := loadTicket(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		dg, err := delegationsFor(ctx, tx, t.ApproverID)
		if err != nil {
			return nil, err
		}
		if !shared.CanView(a.Principal, t.Ref(), dg, s.Now()).Allow {
			return nil, apperr.NotFound("ticket not found")
		}
		if d := shared.CanRevoke(a.Principal, t.Ref()); !d.Allow {
			return nil, apperr.NewForbidden(d.Reason)
		}
		if err := setStatus(ctx, tx, id, t.Status, shared.StatusRevoked, setCol{"decision_reason", reason}); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, "UPDATE download_tokens SET used_at=now() WHERE ticket_id=$1 AND used_at IS NULL", id); err != nil {
			return nil, err
		}
		var rs any
		if reason != nil {
			rs = *reason
		}
		if err := event(ctx, tx, id, a.Principal.ID, "revoked", map[string]any{"reason": rs}); err != nil {
			return nil, err
		}
		if err := s.audT(ctx, tx, a, "transfer.revoke", t, ip, map[string]any{"reason": rs, "fromStatus": string(t.Status), "downloadCount": t.DownloadCount,
			"remainingDownloads": downloadsLeft(t), "revokedBy": s.person(ctx, tx, a.Principal.ID)}); err != nil {
			return nil, err
		}
		if err := outbox.Enqueue(ctx, tx, "purge", map[string]any{"ticketId": id}, outbox.EnqueueOpts{DedupeKey: "purge:" + id}); err != nil {
			return nil, err
		}
		fresh, err := loadTicket(ctx, tx, id, false)
		if err != nil {
			return nil, err
		}
		v := fresh.View()
		return &v, nil
	})
}

func (s *Service) ChangeApprover(ctx context.Context, a *auth.Ctx, id, approverID, ip string) (*TicketView, error) {
	if !shared.HasPermission(&a.Principal, "admin:manage") {
		return nil, apperr.NewForbidden("forbidden")
	}
	return db.Tx(ctx, s.DB, func(tx db.Runner) (*TicketView, error) {
		t, err := loadTicket(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		if strings.EqualFold(approverID, t.RequesterID) {
			return nil, apperr.Validation("approver cannot be the requester")
		}
		var one int
		err = tx.QueryRow(ctx, "SELECT 1 FROM role_assignments ra JOIN users u ON u.id=ra.user_id WHERE ra.user_id=$1 AND ra.role='leader' AND u.active", approverID).Scan(&one)
		if err != nil {
			if db.IsNoRows(err) {
				return nil, apperr.Validation("not an active leader")
			}
			return nil, err
		}
		switch t.Status {
		case shared.StatusRejected, shared.StatusExpired, shared.StatusRevoked, shared.StatusQuarantined, shared.StatusAborted:
			return nil, apperr.Conflict("ticket is " + string(t.Status))
		}
		if _, err := tx.Exec(ctx, "UPDATE tickets SET approver_id=$2, updated_at=now() WHERE id=$1", id, approverID); err != nil {
			return nil, err
		}
		if err := event(ctx, tx, id, a.Principal.ID, "approver.changed", map[string]any{"from": t.ApproverID, "to": approverID}); err != nil {
			return nil, err
		}
		if err := s.audT(ctx, tx, a, "transfer.change_approver", t, ip, map[string]any{"from": t.ApproverID, "to": approverID,
			"fromApprover": s.person(ctx, tx, t.ApproverID), "toApprover": s.person(ctx, tx, approverID), "changedBy": s.person(ctx, tx, a.Principal.ID)}); err != nil {
			return nil, err
		}
		if t.Status == shared.StatusPendingApproval {
			if _, err := tx.Exec(ctx, "UPDATE tickets SET notify_state='PENDING' WHERE id=$1", id); err != nil {
				return nil, err
			}
			if err := s.queueMail(ctx, tx, "approval", id, ":"+approverID); err != nil {
				return nil, err
			}
		}
		fresh, err := loadTicket(ctx, tx, id, false)
		if err != nil {
			return nil, err
		}
		v := fresh.View()
		return &v, nil
	})
}

// ---- download

func (s *Service) IssueDownloadToken(ctx context.Context, a *auth.Ctx, id, ip string) (token string, expiresInSec int, err error) {
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return "", 0, err
	}
	dg, err := delegationsFor(ctx, s.DB, t.ApproverID)
	if err != nil {
		return "", 0, err
	}
	now := s.Now()
	if !shared.CanView(a.Principal, t.Ref(), dg, now).Allow {
		return "", 0, apperr.NotFound("ticket not found")
	}
	if d := shared.CanDownload(a.Principal, t.Ref(), now, a.Kind); !d.Allow {
		return "", 0, apperr.NewForbidden(d.Reason)
	}
	age := now.Sub(a.AuthTime).Seconds()
	if age > s.Cfg.DownloadReauthMaxAgeSec {
		return "", 0, apperr.New(apperr.StepupRequired, "please sign in again to download")
	}
	token = crypto.RandomToken(32)
	if _, err := s.DB.Exec(ctx, "INSERT INTO download_tokens (token_hash, ticket_id, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '60 seconds')", crypto.Sha256HexString(token), id, a.Principal.ID); err != nil {
		return "", 0, err
	}
	if err := s.audT(ctx, s.DB, a, "transfer.download_token", t, ip, map[string]any{"tokenTtlSec": 60, "downloadCount": t.DownloadCount, "remainingDownloads": downloadsLeft(t),
		"requestedBy": s.person(ctx, s.DB, a.Principal.ID), "client": string(a.Kind)}); err != nil {
		return "", 0, err
	}
	return token, 60, nil
}

type Download struct {
	FileName string
	Size     int64
	SHA256   string
	Body     io.Reader
	Ticket   *Ticket
	Started  time.Time
}

// FinishDownload audits how a download ended: bytes actually sent and whether they hash to the recorded sha256.
// sentSHA is the hex digest of the bytes written to the client (computed while streaming; the file is never re-read).
func (s *Service) FinishDownload(ctx context.Context, a *auth.Ctx, dl *Download, ip string, sent int64, sentSHA string, copyErr error) {
	ctx = context.WithoutCancel(ctx) // a client that hung up must still leave a trace
	dur := time.Since(dl.Started).Milliseconds()
	ex := map[string]any{"bytesSent": sent, "expectedBytes": dl.Size, "durationMs": dur, "client": string(a.Kind),
		"downloadCount": dl.Ticket.DownloadCount + 1, "remainingDownloads": downloadsLeft(&Ticket{MaxDownloads: dl.Ticket.MaxDownloads, DownloadCount: dl.Ticket.DownloadCount + 1})}
	action := "transfer.download_completed"
	if copyErr != nil || sent != dl.Size {
		action = "transfer.download_failed"
		msg := "incomplete transfer"
		if copyErr != nil {
			msg = copyErr.Error()
		}
		ex["error"] = inspect.SanitizeName(msg, 200)
	} else {
		ex["shaMatched"] = sentSHA == dl.SHA256
		if sentSHA != dl.SHA256 {
			action = "transfer.download_failed"
			ex["error"] = "sha256 of the bytes sent does not match the recorded digest"
		}
	}
	if sentSHA != "" {
		ex["sentSha256"] = sentSHA
	}
	if err := s.audT(ctx, s.DB, a, action, dl.Ticket, ip, ex); err != nil {
		slog.Error("audit download end failed", "err", err.Error())
	}
}

func (s *Service) OpenDownload(ctx context.Context, a *auth.Ctx, id, token, ip string) (*Download, error) {
	var th string
	err := s.DB.QueryRow(ctx,
		`UPDATE download_tokens SET used_at=now() WHERE token_hash=$1 AND ticket_id::text=$2 AND user_id=$3 AND used_at IS NULL AND expires_at > now() RETURNING token_hash`,
		crypto.Sha256HexString(token), id, a.Principal.ID).Scan(&th)
	if err != nil {
		if db.IsNoRows(err) {
			return nil, apperr.NewForbidden("download token invalid, expired or already used")
		}
		return nil, err
	}
	// policy is evaluated again *now*, not at token issue time
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return nil, err
	}
	if d := shared.CanDownload(a.Principal, t.Ref(), s.Now(), a.Kind); !d.Allow {
		return nil, apperr.NewForbidden(d.Reason)
	}
	err = s.DB.InTx(ctx, func(tx db.Runner) error {
		u, err := tx.Exec(ctx,
			`UPDATE tickets SET download_count=download_count+1, status='DOWNLOADED', first_downloaded_at=COALESCE(first_downloaded_at, now()), updated_at=now()
			 WHERE id=$1 AND status IN ('APPROVED','DOWNLOADED') AND download_count < max_downloads AND (expires_at IS NULL OR expires_at > now())`, id)
		if err != nil {
			return err
		}
		if u.RowsAffected() == 0 {
			return apperr.NewForbidden("download no longer permitted")
		}
		var ipv *string
		if ip != "" {
			ipv = &ip
		}
		if _, err := tx.Exec(ctx, "INSERT INTO downloads (ticket_id, user_id, ip, sha256, bytes) VALUES ($1,$2,$3,$4,$5)", id, a.Principal.ID, ipv, t.SHA256, t.Size); err != nil {
			return err
		}
		if err := event(ctx, tx, id, a.Principal.ID, "downloaded", map[string]any{"sha256": t.SHA256}); err != nil {
			return err
		}
		return s.audT(ctx, tx, a, "transfer.download", t, ip, map[string]any{"sha256": t.SHA256, "bytes": t.Size, "direction": t.Direction, "client": a.Kind,
			"downloadCount": t.DownloadCount + 1, "remainingDownloads": downloadsLeft(&Ticket{MaxDownloads: t.MaxDownloads, DownloadCount: t.DownloadCount + 1}),
			"downloadedBy": s.person(ctx, tx, a.Principal.ID)})
	})
	if err != nil {
		return nil, err
	}
	rd, err := s.plaintext(t)
	if err != nil {
		return nil, err
	}
	return &Download{FileName: t.FileName, Size: t.Size, SHA256: t.SHA256, Body: rd, Ticket: t, Started: time.Now()}, nil
}

// ---- views

type TicketEvent struct {
	ID      int64          `json:"id"`
	At      string         `json:"at"`
	ActorID *string        `json:"actor_id"`
	Kind    string         `json:"kind"`
	Data    map[string]any `json:"data"`
}

type Detail struct {
	Ticket        TicketView    `json:"ticket"`
	Events        []TicketEvent `json:"events"`
	ReceivedParts []int         `json:"receivedParts"`
	TotalParts    int           `json:"totalParts"`
	// trace / compliance additions (additive)
	Uploader *Person       `json:"uploader"`
	Upload   *UploadView   `json:"upload"`
	FileType *FileTypeView `json:"fileType"`
	Scan     *ScanView     `json:"scan"`
	Manifest *ManifestView `json:"manifest"`
	PII      *pii.Report   `json:"pii,omitempty"`
}

type UploadView struct {
	StartedAt     *string `json:"startedAt"`
	CompletedAt   *string `json:"completedAt"`
	DurationMs    *int64  `json:"durationMs"`
	Parts         int     `json:"parts"`
	ThroughputBps *int64  `json:"throughputBps"`
	ClientKind    *string `json:"clientKind"`
	ClientIP      *string `json:"clientIp,omitempty"`  // audit:read only
	UserAgent     *string `json:"userAgent,omitempty"` // audit:read only
}

type FileTypeView struct {
	DeclaredExt  string `json:"declaredExt"`
	Detected     string `json:"detected"`
	Label        string `json:"label"`
	Mismatch     bool   `json:"mismatch"`
	MismatchNote string `json:"mismatchNote,omitempty"`
	Executable   bool   `json:"executable"`
}

type ScanView struct {
	Reason    string  `json:"reason,omitempty"`
	Result    *string `json:"result"`
	Signature string  `json:"signature,omitempty"`
	ScannedAt *string `json:"scannedAt,omitempty"`
	Engine    string  `json:"engine,omitempty"`
	Ms        *int    `json:"ms,omitempty"`
}

// scanKind reduces "infected:<signature>" to "infected".
func scanKind(r string) string {
	if strings.HasPrefix(r, "skipped:") {
		return "skipped"
	}
	if strings.HasPrefix(r, "infected") {
		return "infected"
	}
	return r
}

func (s *Service) GetTicketFor(ctx context.Context, a *auth.Ctx, id string) (*Detail, error) {
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return nil, err
	}
	dg, err := delegationsFor(ctx, s.DB, t.ApproverID)
	if err != nil {
		return nil, err
	}
	if !shared.CanView(a.Principal, t.Ref(), dg, s.Now()).Allow {
		return nil, apperr.NotFound("ticket not found")
	}
	rows, err := s.DB.Query(ctx, "SELECT id, at, actor_id::text, kind, data FROM ticket_events WHERE ticket_id=$1 ORDER BY id", id)
	if err != nil {
		return nil, err
	}
	events := []TicketEvent{}
	for rows.Next() {
		var e TicketEvent
		var at time.Time
		if err := rows.Scan(&e.ID, &at, &e.ActorID, &e.Kind, &e.Data); err != nil {
			rows.Close()
			return nil, err
		}
		e.At = isoMillis(at)
		events = append(events, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	parts, err := s.receivedParts(ctx, s.DB, id)
	if err != nil {
		return nil, err
	}
	d := &Detail{Ticket: t.View(), Events: events, ReceivedParts: parts, TotalParts: t.TotalParts}
	for _, e := range events {
		if e.Kind == "scan.pii" {
			var report pii.Report
			data, err := json.Marshal(e.Data)
			if err == nil && json.Unmarshal(data, &report) == nil {
				d.PII = &report
			}
		}
	}
	up := s.person(ctx, s.DB, t.RequesterID)
	d.Uploader = &up
	uv := &UploadView{Parts: t.TotalParts, ClientKind: t.ClientKind}
	if t.UploadStartedAt != nil {
		x := isoMillis(*t.UploadStartedAt)
		uv.StartedAt = &x
	}
	if t.UploadCompletedAt != nil {
		x := isoMillis(*t.UploadCompletedAt)
		uv.CompletedAt = &x
		if t.UploadStartedAt != nil {
			ms := t.UploadCompletedAt.Sub(*t.UploadStartedAt).Milliseconds()
			uv.DurationMs = &ms
			if ms > 0 {
				bps := t.Size * 1000 / ms
				uv.ThroughputBps = &bps
			}
		}
	}
	if shared.HasPermission(&a.Principal, "audit:read") {
		uv.ClientIP, uv.UserAgent = t.ClientIP, t.ClientUA
	}
	d.Upload = uv
	if t.ScanResult != nil {
		sv := &ScanView{Ms: t.ScanMs}
		k := scanKind(*t.ScanResult)
		sv.Result = &k
		if k == "skipped" {
			sv.Reason = strings.TrimPrefix(*t.ScanResult, "skipped:")
		}
		if k == "infected" {
			sv.Signature = strings.TrimPrefix(*t.ScanResult, "infected:")
		}
		if t.ScannedAt != nil {
			x := isoMillis(*t.ScannedAt)
			sv.ScannedAt = &x
		}
		if t.ScanEngine != nil {
			sv.Engine = *t.ScanEngine
		}
		d.Scan = sv
	}
	if s.canSeeContent(ctx, s.DB, a, t) {
		if mv, err := s.loadManifest(ctx, s.DB, id, 0, 100, false); err == nil && mv != nil {
			d.Manifest = mv
			var m inspect.Manifest
			if json.Unmarshal(mv.Summary, &m) == nil && mv.Status == "ok" {
				d.FileType = &FileTypeView{DeclaredExt: m.DeclaredExt, Detected: m.DetectedType, Label: m.Label, Mismatch: m.TypeMismatch, MismatchNote: m.MismatchNote, Executable: m.Executable}
			}
		}
	}
	return d, nil
}

func (s *Service) ListTickets(ctx context.Context, a *auth.Ctx, view, status string) ([]TicketView, error) {
	uid := a.Principal.ID
	var conds []string
	var params []any
	p := func(v any) string { params = append(params, v); return fmt.Sprintf("$%d", len(params)) }
	switch view {
	case "sent":
		conds = append(conds, "t.requester_id="+p(uid))
	case "inbox":
		conds = append(conds, "("+p(uid)+"::uuid = ANY(t.recipient_ids)) AND t.status IN ('APPROVED','DOWNLOADED')")
	case "approvals":
		conds = append(conds, "(t.approver_id="+p(uid)+" OR EXISTS (SELECT 1 FROM delegations d WHERE d.from_user_id=t.approver_id AND d.to_user_id="+p(uid)+" AND NOT d.revoked AND d.valid_from<=now() AND d.valid_to>=now()))")
		if !shared.HasPermission(&a.Principal, "transfer:approve") {
			return nil, apperr.NewForbidden("forbidden")
		}
	case "all":
		if !shared.HasPermission(&a.Principal, "audit:read") {
			return nil, apperr.NewForbidden("forbidden")
		}
	default:
		return nil, apperr.Validation("unknown view")
	}
	if status != "" {
		conds = append(conds, "t.status="+p(status))
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	rows, err := s.DB.Query(ctx, `SELECT `+ticketCols+` FROM tickets t LEFT JOIN users ap ON ap.id=t.approver_id `+where+` ORDER BY t.created_at DESC LIMIT 200`, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TicketView{}
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t.View())
	}
	return out, rows.Err()
}
