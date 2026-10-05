// Package tickets: the file-transfer workflow (services/tickets.ts).
package tickets

import (
	"context"
	"encoding/json"
	"io"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/shared"
)

// ticketCols is the column list scanned by scanTicket (uuids cast to text so they scan into strings).
const ticketCols = `t.id::text, t.code, t.requester_id::text, t.approver_id::text, t.recipient_ids::text[], t.file_name, t.size, t.sha256, t.purpose,
	t.status, t.notify_state, t.part_bytes, t.total_parts, t.dek_wrapped, t.complete_idem_key, t.scan_result, t.decision_reason,
	t.expires_at, t.download_count, t.max_downloads, t.created_at, t.direction, ap.email, ap.name,
	t.upload_started_at, t.upload_completed_at, t.client_ip, t.client_user_agent, t.client_kind, t.scan_engine, t.scan_ms, t.scanned_at`

type Ticket struct {
	ID, Code, RequesterID, ApproverID             string
	RecipientIDs                                  []string
	FileName                                      string
	Size                                          int64
	SHA256, Purpose                               string
	Status                                        shared.TicketStatus
	NotifyState                                   string
	PartBytes, TotalParts                         int
	DekWrapped                                    string
	CompleteIdemKey, ScanResult                   *string
	DecisionReason                                *string
	ExpiresAt                                     *time.Time
	DownloadCount, MaxDownloads                   int
	CreatedAt                                     time.Time
	Direction                                     shared.TransferDirection
	ApproverEmail, ApproverName                   *string
	UploadStartedAt, UploadCompletedAt, ScannedAt *time.Time
	ClientIP, ClientUA, ClientKind, ScanEngine    *string
	ScanMs                                        *int
}

func scanTicket(row pgx.Row) (*Ticket, error) {
	t := &Ticket{}
	var status, dir string
	err := row.Scan(&t.ID, &t.Code, &t.RequesterID, &t.ApproverID, &t.RecipientIDs, &t.FileName, &t.Size, &t.SHA256, &t.Purpose,
		&status, &t.NotifyState, &t.PartBytes, &t.TotalParts, &t.DekWrapped, &t.CompleteIdemKey, &t.ScanResult, &t.DecisionReason,
		&t.ExpiresAt, &t.DownloadCount, &t.MaxDownloads, &t.CreatedAt, &dir, &t.ApproverEmail, &t.ApproverName,
		&t.UploadStartedAt, &t.UploadCompletedAt, &t.ClientIP, &t.ClientUA, &t.ClientKind, &t.ScanEngine, &t.ScanMs, &t.ScannedAt)
	if err != nil {
		return nil, err
	}
	t.Status = shared.TicketStatus(status)
	t.Direction = shared.TransferDirection(dir)
	return t, nil
}

// TicketView is the JSON shape of a ticket (packages/shared TicketView). Key order matches the Node output.
type TicketView struct {
	ID             string                   `json:"id"`
	Code           string                   `json:"code"`
	Status         shared.TicketStatus      `json:"status"`
	NotifyState    string                   `json:"notifyState"`
	FileName       string                   `json:"fileName"`
	Size           int64                    `json:"size"`
	SHA256         string                   `json:"sha256"`
	Purpose        string                   `json:"purpose"`
	RequesterID    string                   `json:"requesterId"`
	ApproverID     string                   `json:"approverId"`
	ApproverEmail  *string                  `json:"approverEmail"`
	ApproverName   *string                  `json:"approverName"`
	Direction      shared.TransferDirection `json:"direction"`
	CreatedAt      string                   `json:"createdAt"`
	ExpiresAt      *string                  `json:"expiresAt"`
	DownloadCount  int                      `json:"downloadCount"`
	MaxDownloads   int                      `json:"maxDownloads"`
	DecisionReason *string                  `json:"decisionReason"`
}

func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func (t *Ticket) View() TicketView {
	v := TicketView{ID: t.ID, Code: t.Code, Status: t.Status, NotifyState: t.NotifyState, FileName: t.FileName, Size: t.Size, SHA256: t.SHA256,
		Purpose: t.Purpose, RequesterID: t.RequesterID, ApproverID: t.ApproverID, ApproverEmail: t.ApproverEmail, Direction: t.Direction,
		CreatedAt: isoMillis(t.CreatedAt), DownloadCount: t.DownloadCount, MaxDownloads: t.MaxDownloads, DecisionReason: t.DecisionReason}
	if t.ApproverName != nil && *t.ApproverName != "" {
		v.ApproverName = t.ApproverName
	}
	if t.ExpiresAt != nil {
		s := isoMillis(*t.ExpiresAt)
		v.ExpiresAt = &s
	}
	return v
}

func (t *Ticket) Ref() shared.TicketRef {
	return shared.TicketRef{ID: t.ID, RequesterID: t.RequesterID, ApproverID: t.ApproverID, RecipientIDs: t.RecipientIDs, Status: t.Status,
		ExpiresAt: t.ExpiresAt, DownloadCount: t.DownloadCount, MaxDownloads: t.MaxDownloads, Direction: t.Direction}
}

var idRe = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func loadTicket(ctx context.Context, q db.Querier, id string, forUpdate bool) (*Ticket, error) {
	if !idRe.MatchString(id) {
		return nil, apperr.NotFound("ticket not found")
	}
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE OF t"
	}
	t, err := scanTicket(q.QueryRow(ctx, `SELECT `+ticketCols+` FROM tickets t LEFT JOIN users ap ON ap.id=t.approver_id WHERE t.id=$1`+lock, id))
	if err != nil {
		if db.IsNoRows(err) {
			return nil, apperr.NotFound("ticket not found")
		}
		return nil, err
	}
	return t, nil
}

func delegationsFor(ctx context.Context, q db.Querier, approverID string) ([]shared.Delegation, error) {
	rows, err := q.Query(ctx, "SELECT from_user_id::text, to_user_id::text, valid_from, valid_to, revoked FROM delegations WHERE from_user_id=$1", approverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []shared.Delegation
	for rows.Next() {
		var d shared.Delegation
		if err := rows.Scan(&d.FromUserID, &d.ToUserID, &d.ValidFrom, &d.ValidTo, &d.Revoked); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func event(ctx context.Context, q db.Querier, ticketID string, actorID string, kind string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	b, _ := json.Marshal(data)
	var actor *string
	if actorID != "" {
		actor = &actorID
	}
	_, err := q.Exec(ctx, "INSERT INTO ticket_events (ticket_id, actor_id, kind, data) VALUES ($1,$2,$3,$4::jsonb)", ticketID, actor, kind, string(b))
	return err
}

type setCol struct {
	Col string
	Val any
}

func setStatus(ctx context.Context, q db.Querier, id string, from, to shared.TicketStatus, extra ...setCol) error {
	if !shared.CanTransition(from, to) {
		return apperr.Conflict("illegal transition " + string(from) + " -> " + string(to))
	}
	sets := "status=$2, updated_at=now()"
	args := []any{id, string(to)}
	for _, e := range extra {
		args = append(args, e.Val)
		sets += ", " + e.Col + "=$" + itoa(len(args))
	}
	args = append(args, string(from))
	tag, err := q.Exec(ctx, "UPDATE tickets SET "+sets+" WHERE id=$1 AND status=$"+itoa(len(args)), args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.Conflict("ticket changed concurrently")
	}
	return nil
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}

// ---- plaintext streaming (decrypts part by part; GCM authenticates each part, AAD binds ticket+index)

func partKey(ticketID string, n int) string { return ticketID + "/" + itoa(n) }
func partAAD(ticketID string, n int) []byte { return []byte("part:" + ticketID + ":" + itoa(n)) }

type partsReader struct {
	s   *Service
	t   *Ticket
	dek []byte
	n   int // parts loaded so far
	buf []byte
	err error
}

func (s *Service) plaintext(t *Ticket) (io.Reader, error) {
	dek, err := s.Keys.Unwrap(t.DekWrapped)
	if err != nil {
		return nil, err
	}
	return &partsReader{s: s, t: t, dek: dek}, nil
}

func (r *partsReader) Read(p []byte) (int, error) {
	for len(r.buf) == 0 {
		if r.err != nil {
			return 0, r.err
		}
		if r.n >= r.t.TotalParts {
			return 0, io.EOF
		}
		r.n++
		ct, err := r.s.Store.Get(partKey(r.t.ID, r.n))
		if err != nil {
			r.err = err
			continue
		}
		pt, err := crypto.OpenBuffer(r.dek, ct, partAAD(r.t.ID, r.n))
		if err != nil {
			r.err = err
			continue
		}
		r.buf = pt
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}
