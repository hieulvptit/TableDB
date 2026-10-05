package audit

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/db"
)

// Row is one stored audit entry as read back (everything the chain hash covers, plus prev_hash/hash and ip).
type Row struct {
	Seq          int64           `json:"seq"`
	At           string          `json:"at"`
	ActorID      *string         `json:"actorId"`
	ActorLabel   string          `json:"actorLabel"`
	Action       string          `json:"action"`
	ResourceType string          `json:"resourceType"`
	ResourceID   string          `json:"resourceId"`
	IP           *string         `json:"ip"`
	Detail       json.RawMessage `json:"detail"`
	PrevHash     string          `json:"prevHash"`
	Hash         string          `json:"hash"`
}

// Filter selects audit rows. Zero values mean "no constraint".
type Filter struct {
	ActorID    string
	ActorLike  string // substring of actor_label (case-insensitive)
	Action     string // prefix
	From, To   *time.Time
	ResourceID string
	TicketCode string
	TicketID   string // resource_id = id OR detail.ticketId = id (the whole life of one ticket)
	Before     int64  // seq < Before
	MinSeq     int64  // seq >= MinSeq
	MaxSeq     int64  // seq <= MaxSeq
}

func escLike(s string) string { return strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(s) }

func (f Filter) where() (string, []any) {
	var conds []string
	var params []any
	add := func(sql string, v any) {
		params = append(params, v)
		conds = append(conds, strings.Replace(sql, "?", fmt.Sprintf("$%d", len(params)), 1))
	}
	if f.ActorID != "" {
		add("actor_id = ?", f.ActorID)
	}
	if f.ActorLike != "" {
		add(`actor_label ILIKE ? ESCAPE '\'`, "%"+escLike(f.ActorLike)+"%")
	}
	if f.Action != "" {
		add(`action LIKE ? ESCAPE '\'`, escLike(f.Action)+"%")
	}
	if f.From != nil {
		add("at >= ?", *f.From)
	}
	if f.To != nil {
		add("at <= ?", *f.To)
	}
	if f.ResourceID != "" {
		add("resource_id = ?", f.ResourceID)
	}
	if f.TicketCode != "" {
		add("(resource_id IN (SELECT id::text FROM tickets WHERE code = ?))", f.TicketCode)
	}
	if f.TicketID != "" {
		params = append(params, f.TicketID)
		n := len(params)
		conds = append(conds, fmt.Sprintf("(resource_id = $%d OR detail->>'ticketId' = $%d)", n, n))
	}
	if f.Before > 0 {
		add("seq < ?", f.Before)
	}
	if f.MinSeq > 0 {
		add("seq >= ?", f.MinSeq)
	}
	if f.MaxSeq > 0 {
		add("seq <= ?", f.MaxSeq)
	}
	if len(conds) == 0 {
		return "", params
	}
	return "WHERE " + strings.Join(conds, " AND "), params
}

const rowCols = `seq, at, actor_id::text, actor_label, action, resource_type, resource_id, ip, detail::text, prev_hash, hash`

func scanRows(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}) ([]Row, error) {
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var at time.Time
		var detail string
		if err := rows.Scan(&r.Seq, &at, &r.ActorID, &r.ActorLabel, &r.Action, &r.ResourceType, &r.ResourceID, &r.IP, &detail, &r.PrevHash, &r.Hash); err != nil {
			return nil, err
		}
		r.At = isoMillis(at)
		r.Detail = json.RawMessage(detail)
		out = append(out, r)
	}
	return out, rows.Err()
}

// List returns up to limit rows, newest first (desc) or oldest first.
func List(ctx context.Context, q db.Querier, f Filter, limit int, desc bool) ([]Row, error) {
	where, params := f.where()
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	params = append(params, limit)
	rows, err := q.Query(ctx, fmt.Sprintf("SELECT %s FROM audit_log %s ORDER BY seq %s LIMIT $%d", rowCols, where, dir, len(params)), params...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

// SeqRange resolves a time window to a contiguous seq window (the chain is verified by seq, and `at` is not strictly monotone).
func SeqRange(ctx context.Context, q db.Querier, from, to *time.Time) (min, max int64, err error) {
	f := Filter{From: from, To: to}
	where, params := f.where()
	var mn, mx *int64
	if err = q.QueryRow(ctx, "SELECT min(seq), max(seq) FROM audit_log "+where, params...).Scan(&mn, &mx); err != nil {
		return
	}
	if mn != nil && mx != nil {
		min, max = *mn, *mx
	}
	return
}

// Each streams rows with seq in [min,max] in ascending order using keyset pages (bounded memory).
func Each(ctx context.Context, q db.Querier, min, max int64, fn func(Row) error) error {
	last := min - 1
	for {
		rows, err := q.Query(ctx, fmt.Sprintf("SELECT %s FROM audit_log WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT 1000", rowCols), last, max)
		if err != nil {
			return err
		}
		batch, err := scanRows(rows)
		if err != nil {
			return err
		}
		for _, r := range batch {
			if err := fn(r); err != nil {
				return err
			}
			last = r.Seq
		}
		if len(batch) < 1000 {
			return nil
		}
	}
}

// ---- offline verification of an exported JSONL file

type FileVerification struct {
	OK                bool   `json:"ok"`
	Checked           int    `json:"checked"`
	FirstSeq          int64  `json:"firstSeq"`
	LastSeq           int64  `json:"lastSeq"`
	AnchoredAtGenesis bool   `json:"anchoredAtGenesis"` // first row links to the genesis hash (a full export)
	AnchorPrevHash    string `json:"anchorPrevHash"`    // for a partial export: the hash that must equal the previous row elsewhere
	BrokenAtSeq       int64  `json:"brokenAtSeq,omitempty"`
	Reason            string `json:"reason,omitempty"`
}

// VerifyJSONL recomputes every row hash and checks prev_hash linking and seq contiguity of an export made by /audit/export.
// It needs nothing but the file: this is the offline check a reviewer runs.
func VerifyJSONL(r io.Reader) (FileVerification, error) {
	var v FileVerification
	sc := bufio.NewReaderSize(r, 1<<20)
	prev := ""
	var lastSeq int64
	for {
		line, err := sc.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var raw struct {
				Seq          int64           `json:"seq"`
				At           string          `json:"at"`
				ActorID      *string         `json:"actorId"`
				ActorLabel   string          `json:"actorLabel"`
				Action       string          `json:"action"`
				ResourceType string          `json:"resourceType"`
				ResourceID   string          `json:"resourceId"`
				Detail       json.RawMessage `json:"detail"`
				PrevHash     string          `json:"prevHash"`
				Hash         string          `json:"hash"`
			}
			if jerr := json.Unmarshal(line, &raw); jerr != nil {
				v.Reason, v.BrokenAtSeq = "line is not valid JSON: "+jerr.Error(), lastSeq+1
				return v, nil
			}
			if v.Checked == 0 {
				v.FirstSeq = raw.Seq
				v.AnchorPrevHash = raw.PrevHash
				v.AnchoredAtGenesis = raw.PrevHash == Genesis
				prev = raw.PrevHash
			} else if raw.Seq != lastSeq+1 {
				v.Reason, v.BrokenAtSeq = fmt.Sprintf("missing rows between seq %d and %d", lastSeq, raw.Seq), raw.Seq
				return v, nil
			}
			if raw.PrevHash != prev {
				v.Reason, v.BrokenAtSeq = "prevHash does not match the previous row", raw.Seq
				return v, nil
			}
			at, perr := time.Parse(time.RFC3339Nano, raw.At)
			if perr != nil {
				v.Reason, v.BrokenAtSeq = "bad timestamp", raw.Seq
				return v, nil
			}
			if digest(prev, isoMillis(at), raw.ActorID, raw.ActorLabel, raw.Action, raw.ResourceType, raw.ResourceID, decodeJSON(raw.Detail)) != raw.Hash {
				v.Reason, v.BrokenAtSeq = "hash mismatch (row was altered)", raw.Seq
				return v, nil
			}
			prev, lastSeq = raw.Hash, raw.Seq
			v.Checked++
			v.LastSeq = raw.Seq
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return v, err
		}
	}
	v.OK = true
	return v, nil
}
