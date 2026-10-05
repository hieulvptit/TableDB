package tickets

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/inspect"
	"vnpay/tabledb-api/internal/reqmeta"
	"vnpay/tabledb-api/internal/shared"
)

// Person is who, at the time of the event (e-mail and name are copied into the trail so a later rename does not rewrite history).
type Person struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func (s *Service) person(ctx context.Context, q db.Querier, id string) Person {
	p := Person{ID: id}
	if id == "" {
		return p
	}
	_ = q.QueryRow(ctx, "SELECT email, name FROM users WHERE id=$1", id).Scan(&p.Email, &p.Name)
	p.Name = inspect.SanitizeName(p.Name, 120)
	return p
}

// Person is the exported lookup used by route-level audit entries (delegations).
func (s *Service) Person(ctx context.Context, q db.Querier, id string) Person {
	return s.person(ctx, q, id)
}

func merge(base map[string]any, extra map[string]any) map[string]any {
	for k, v := range extra {
		base[k] = v
	}
	return base
}

// base is the who/what every ticket audit entry carries: ids, direction, sanitized file name, declared size, sha256,
// purpose, requester and approver (as of now) and the recipients' e-mails.
func (s *Service) base(ctx context.Context, q db.Querier, t *Ticket) map[string]any {
	m := map[string]any{
		"ticketId": t.ID, "code": t.Code, "direction": string(t.Direction),
		"fileName": inspect.SanitizeName(t.FileName, 255), "declaredSize": t.Size, "sha256": t.SHA256,
		"purpose":   inspect.SanitizeName(t.Purpose, 300),
		"requester": s.person(ctx, q, t.RequesterID), "approver": s.person(ctx, q, t.ApproverID),
	}
	rec := []string{}
	if len(t.RecipientIDs) > 0 {
		if rows, err := q.Query(ctx, "SELECT email FROM users WHERE id = ANY($1::uuid[]) ORDER BY email", t.RecipientIDs); err == nil {
			for rows.Next() {
				var e string
				if rows.Scan(&e) == nil {
					rec = append(rec, e)
				}
			}
			rows.Close()
		}
	}
	m["recipients"] = rec
	if t.ClientKind != nil {
		m["clientKind"] = *t.ClientKind
	}
	return m
}

// audT writes a user-attributed audit entry for a ticket with the full base detail.
func (s *Service) audT(ctx context.Context, q db.Runner, a *auth.Ctx, action string, t *Ticket, ip string, extra map[string]any) error {
	return s.aud(ctx, q, a, action, "ticket", t.ID, ip, merge(s.base(ctx, q, t), extra))
}

// sysAuditT writes a system-attributed audit entry for a ticket with the full base detail.
func (s *Service) sysAuditT(ctx context.Context, q db.Runner, action string, t *Ticket, extra map[string]any) error {
	return s.sysAudit(ctx, q, action, t.ID, merge(s.base(ctx, q, t), extra))
}

func downloadsLeft(t *Ticket) int {
	if n := t.MaxDownloads - t.DownloadCount; n > 0 {
		return n
	}
	return 0
}

func iso(t *time.Time) any {
	if t == nil {
		return nil
	}
	return isoMillis(*t)
}

// uploadTiming derives started/completed/duration/throughput for audit and views.
func uploadTiming(t *Ticket) map[string]any {
	m := map[string]any{"parts": t.TotalParts}
	if t.UploadStartedAt != nil {
		m["uploadStartedAt"] = isoMillis(*t.UploadStartedAt)
	}
	if t.UploadCompletedAt != nil {
		m["uploadCompletedAt"] = isoMillis(*t.UploadCompletedAt)
		if t.UploadStartedAt != nil {
			d := t.UploadCompletedAt.Sub(*t.UploadStartedAt)
			ms := d.Milliseconds()
			m["uploadDurationMs"] = ms
			if ms > 0 {
				m["throughputBps"] = t.Size * 1000 / ms
			}
		}
	}
	return m
}

// ---------------------------------------------------------------- random access over the encrypted parts (no temp files)

type partsReaderAt struct {
	s     *Service
	t     *Ticket
	dek   []byte
	cache map[int][]byte
	order []int
}

func (s *Service) plaintextAt(t *Ticket) (io.ReaderAt, error) {
	dek, err := s.Keys.Unwrap(t.DekWrapped)
	if err != nil {
		return nil, err
	}
	return &partsReaderAt{s: s, t: t, dek: dek, cache: map[int][]byte{}}, nil
}

func (r *partsReaderAt) part(n int) ([]byte, error) {
	if b, ok := r.cache[n]; ok {
		return b, nil
	}
	ct, err := r.s.Store.Get(partKey(r.t.ID, n))
	if err != nil {
		return nil, err
	}
	pt, err := crypto.OpenBuffer(r.dek, ct, partAAD(r.t.ID, n))
	if err != nil {
		return nil, err
	}
	r.cache[n] = pt
	r.order = append(r.order, n)
	if len(r.order) > 3 { // bounded memory: at most 3 decrypted parts
		delete(r.cache, r.order[0])
		r.order = r.order[1:]
	}
	return pt, nil
}

func (r *partsReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, fmt.Errorf("negative offset")
	}
	n := 0
	for n < len(p) {
		if off >= r.t.Size {
			return n, io.EOF
		}
		pb := int64(r.t.PartBytes)
		part := int(off/pb) + 1
		b, err := r.part(part)
		if err != nil {
			return n, err
		}
		po := off - int64(part-1)*pb
		if po >= int64(len(b)) {
			return n, io.ErrUnexpectedEOF
		}
		c := copy(p[n:], b[po:])
		n += c
		off += int64(c)
	}
	return n, nil
}

// ---------------------------------------------------------------- manifest

type manifestRecord struct {
	Status     string
	Error      string
	Manifest   inspect.Manifest
	Entries    []inspect.Entry
	DurationMs int
	Hash       string
	summaryAny any
}

func (s *Service) inspectOptions() inspect.Options {
	c := s.Cfg
	return inspect.Options{MaxDepth: c.InspectMaxDepth, MaxEntries: c.InspectMaxEntries, MaxTotalBytes: c.InspectMaxBytes, MaxRatio: c.InspectMaxRatio,
		Timeout: time.Duration(c.InspectTimeoutSec * float64(time.Second)), EntryHashMaxBytes: c.InspectEntryHashMaxBytes, NestedMaxBytes: c.InspectNestedMaxBytes}
}

func toAny(v any) any {
	b, _ := json.Marshal(v)
	return audit.DecodeJSON(b)
}

func manifestHash(summary any, entries any) string {
	return audit.CanonSHA256(map[string]any{"summary": summary, "entries": entries})
}

// inspectTicket runs the inspector on the decrypted parts. It never fails the caller: errors become an 'error' manifest.
func (s *Service) inspectTicket(ctx context.Context, t *Ticket) *manifestRecord {
	if !s.Cfg.InspectEnabled {
		return nil
	}
	rec := &manifestRecord{}
	finish := func() *manifestRecord {
		var entries []inspect.Entry
		if rec.Entries != nil {
			entries = rec.Entries
		} else {
			entries = []inspect.Entry{}
		}
		rec.Entries = entries
		rec.summaryAny = toAny(rec.Manifest)
		rec.Hash = manifestHash(rec.summaryAny, toAny(entries))
		return rec
	}
	rec.Manifest = inspect.Manifest{Version: inspect.ManifestVersion, Size: t.Size, SHA256: t.SHA256, DeclaredExt: inspect.Ext(t.FileName)}
	ra, err := s.plaintextAt(t)
	if err != nil {
		rec.Status, rec.Error = "error", inspect.SanitizeName("open: "+err.Error(), 300)
		return finish()
	}
	res, err := inspect.Run(ctx, inspect.Input{Name: t.FileName, Size: t.Size, SHA256: t.SHA256, RA: ra}, s.inspectOptions())
	if err != nil {
		rec.Status, rec.Error = "error", inspect.SanitizeName(err.Error(), 300)
		return finish()
	}
	rec.Status, rec.Manifest, rec.Entries, rec.DurationMs = "ok", res.Manifest, res.Entries, int(res.DurationMs)
	return finish()
}

// saveManifest stores the manifest (immutable: DB triggers forbid UPDATE/DELETE). Repeated calls are no-ops.
func saveManifest(ctx context.Context, q db.Querier, ticketID string, rec *manifestRecord) (inserted bool, err error) {
	sum, _ := json.Marshal(rec.Manifest)
	var errMsg *string
	if rec.Error != "" {
		errMsg = &rec.Error
	}
	tag, err := q.Exec(ctx, `INSERT INTO ticket_manifests (ticket_id, status, inspect_error, summary, entry_count, manifest_hash, duration_ms)
		VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT (ticket_id) DO NOTHING`, ticketID, rec.Status, errMsg, string(sum), len(rec.Entries), rec.Hash, rec.DurationMs)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	const batch = 500
	for i := 0; i < len(rec.Entries); i += batch {
		end := i + batch
		if end > len(rec.Entries) {
			end = len(rec.Entries)
		}
		js := make([]string, 0, end-i)
		for _, e := range rec.Entries[i:end] {
			b, _ := json.Marshal(e)
			js = append(js, string(b))
		}
		if _, err := q.Exec(ctx, `INSERT INTO ticket_manifest_entries (ticket_id, idx, entry) SELECT $1, $2::int + o - 1, e::jsonb FROM unnest($3::text[]) WITH ORDINALITY AS u(e, o)`, ticketID, i, js); err != nil {
			return false, err
		}
	}
	return true, nil
}

// inspectAuditDetail is the compact summary that goes into the audit chain: counts, flags, types and the manifest hash
// (tamper evidence for the full list, which stays in ticket_manifest_entries). Entries are inlined only up to 50.
func inspectAuditDetail(rec *manifestRecord) map[string]any {
	m := rec.Manifest
	d := map[string]any{"status": rec.Status, "manifestHash": rec.Hash, "entryCount": len(rec.Entries), "durationMs": rec.DurationMs,
		"detectedType": m.DetectedType, "label": m.Label, "declaredExt": m.DeclaredExt, "typeMismatch": m.TypeMismatch, "executable": m.Executable,
		"containsExecutable": m.ContainsExecutable, "containsSensitivePatterns": m.ContainsSensitivePatterns, "truncated": m.Truncated, "actualSize": m.Size}
	if rec.Error != "" {
		d["inspectError"] = rec.Error
	}
	if m.MismatchNote != "" {
		d["mismatchNote"] = m.MismatchNote
	}
	if m.TruncatedReason != "" {
		d["truncatedReason"] = m.TruncatedReason
	}
	if m.ParseError != "" {
		d["parseError"] = m.ParseError
	}
	if m.Sensitive != nil {
		d["sensitive"] = m.Sensitive
	}
	if m.Text != nil {
		t := map[string]any{"encoding": m.Text.Encoding, "lines": m.Text.Lines, "bytes": m.Text.Bytes}
		if c := m.Text.CSV; c != nil {
			t["csv"] = map[string]any{"delimiter": c.Delimiter, "columns": c.Columns, "dataRows": c.DataRows, "raggedRows": c.RaggedRows}
		}
		if j := m.Text.JSON; j != nil {
			t["json"] = map[string]any{"valid": j.Valid, "topLevel": j.TopLevel, "length": j.Length}
		}
		if j := m.Text.JSONL; j != nil {
			t["jsonl"] = map[string]any{"validLines": j.ValidLines, "invalidLines": j.InvalidLines}
		}
		d["text"] = t
	}
	if m.Zip != nil {
		d["zip"] = m.Zip
	}
	if len(rec.Entries) <= 50 && len(rec.Entries) > 0 {
		list := make([]any, 0, len(rec.Entries))
		for _, e := range rec.Entries {
			x := map[string]any{"path": e.Path, "size": e.Size, "compressedSize": e.CompressedSize, "modified": e.Modified, "crc32": e.CRC32, "flags": e.Flags}
			if e.SHA256 != "" {
				x["sha256"] = e.SHA256
			}
			if e.Lines != nil {
				x["lines"] = *e.Lines
			}
			list = append(list, x)
		}
		d["entries"] = list
	}
	return d
}

type EntriesPage struct {
	Offset int               `json:"offset"`
	Limit  int               `json:"limit"`
	Total  int               `json:"total"`
	Items  []json.RawMessage `json:"items"`
}

type ManifestView struct {
	Status       string          `json:"status"`
	InspectError string          `json:"inspectError,omitempty"`
	InspectedAt  string          `json:"inspectedAt"`
	DurationMs   int             `json:"durationMs"`
	ManifestHash string          `json:"manifestHash"`
	Summary      json.RawMessage `json:"summary"`
	Entries      EntriesPage     `json:"entries"`
	HashVerified *bool           `json:"hashVerified,omitempty"`
}

// loadManifest returns nil when the ticket has no manifest yet.
func (s *Service) loadManifest(ctx context.Context, q db.Querier, ticketID string, offset, limit int, verify bool) (*ManifestView, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	v := &ManifestView{}
	var at time.Time
	var errMsg *string
	var summary string
	err := q.QueryRow(ctx, `SELECT status, inspect_error, created_at, duration_ms, manifest_hash, summary::text, entry_count FROM ticket_manifests WHERE ticket_id=$1`, ticketID).
		Scan(&v.Status, &errMsg, &at, &v.DurationMs, &v.ManifestHash, &summary, &v.Entries.Total)
	if err != nil {
		if db.IsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	if errMsg != nil {
		v.InspectError = *errMsg
	}
	v.InspectedAt = isoMillis(at)
	v.Summary = json.RawMessage(summary)
	v.Entries.Offset, v.Entries.Limit = offset, limit
	v.Entries.Items = []json.RawMessage{}
	rows, err := q.Query(ctx, `SELECT entry::text FROM ticket_manifest_entries WHERE ticket_id=$1 ORDER BY idx OFFSET $2 LIMIT $3`, ticketID, offset, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			rows.Close()
			return nil, err
		}
		v.Entries.Items = append(v.Entries.Items, json.RawMessage(e))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if verify {
		ok, err := s.verifyManifest(ctx, q, ticketID, summary, v.ManifestHash)
		if err != nil {
			return nil, err
		}
		v.HashVerified = &ok
	}
	return v, nil
}

// verifyManifest recomputes the manifest hash from what is stored now.
func (s *Service) verifyManifest(ctx context.Context, q db.Querier, ticketID, summary, want string) (bool, error) {
	rows, err := q.Query(ctx, `SELECT entry::text FROM ticket_manifest_entries WHERE ticket_id=$1 ORDER BY idx`, ticketID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	entries := []any{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return false, err
		}
		entries = append(entries, audit.DecodeJSON([]byte(e)))
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return manifestHash(audit.DecodeJSON([]byte(summary)), entries) == want, nil
}

// ---------------------------------------------------------------- access

func (s *Service) isDelegate(ctx context.Context, q db.Querier, a *auth.Ctx, t *Ticket) bool {
	dg, err := delegationsFor(ctx, q, t.ApproverID)
	if err != nil {
		return false
	}
	now := s.Now()
	for _, d := range dg {
		if d.ToUserID == a.Principal.ID && !d.Revoked && !now.Before(d.ValidFrom) && !now.After(d.ValidTo) {
			return true
		}
	}
	return false
}

// canSeeContent: requester, approver, an active delegate, or audit:read. Plain recipients do not see the manifest.
func (s *Service) canSeeContent(ctx context.Context, q db.Querier, a *auth.Ctx, t *Ticket) bool {
	return a.Principal.ID == t.RequesterID || a.Principal.ID == t.ApproverID || shared.HasPermission(&a.Principal, "audit:read") || s.isDelegate(ctx, q, a, t)
}

func (s *Service) viewable(ctx context.Context, a *auth.Ctx, id string) (*Ticket, error) {
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
	return t, nil
}

// GetManifest pages the entry list of a ticket's manifest.
func (s *Service) GetManifest(ctx context.Context, a *auth.Ctx, id string, offset, limit int, verify bool) (*ManifestView, error) {
	t, err := s.viewable(ctx, a, id)
	if err != nil {
		return nil, err
	}
	if !s.canSeeContent(ctx, s.DB, a, t) {
		return nil, apperr.NotFound("ticket not found")
	}
	v, err := s.loadManifest(ctx, s.DB, id, offset, limit, verify)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, apperr.NotFound("manifest not available yet")
	}
	return v, nil
}

type TraceResult struct {
	Ticket   map[string]string `json:"ticket"`
	Entries  []audit.Row       `json:"entries"`
	Redacted bool              `json:"redacted"` // network fields removed for non-auditors; hashes then cannot be re-verified from this view
}

var networkKeys = []string{"userAgent", "xForwardedFor", "sessionRef", "requestId", "clientIp"}

// GetTrace is the ordered timeline of every audit entry for one ticket (audit:read, or requester/approver/delegate of it).
func (s *Service) GetTrace(ctx context.Context, a *auth.Ctx, id string) (*TraceResult, error) {
	t, err := s.viewable(ctx, a, id)
	if err != nil {
		return nil, err
	}
	if !s.canSeeContent(ctx, s.DB, a, t) {
		return nil, apperr.NotFound("ticket not found")
	}
	rows, err := audit.List(ctx, s.DB, audit.Filter{TicketID: id}, 2000, false)
	if err != nil {
		return nil, err
	}
	res := &TraceResult{Ticket: map[string]string{"id": t.ID, "code": t.Code}, Entries: rows}
	if res.Entries == nil {
		res.Entries = []audit.Row{}
	}
	if !shared.HasPermission(&a.Principal, "audit:read") {
		res.Redacted = true
		for i := range res.Entries {
			res.Entries[i].IP = nil
			var d map[string]any
			if json.Unmarshal(res.Entries[i].Detail, &d) == nil {
				for _, k := range networkKeys {
					delete(d, k)
				}
				b, _ := json.Marshal(d)
				res.Entries[i].Detail = b
			}
		}
	}
	return res, nil
}

// ---------------------------------------------------------------- request meta helper

func metaOf(ctx context.Context) reqmeta.Meta {
	m, _ := reqmeta.From(ctx)
	return m
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029 || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
			return true
		}
	}
	return false
}

var _ = strings.TrimSpace
