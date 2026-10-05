// Package audit: append-only, hash-chained audit log (audit.ts). The chain format is byte-compatible with the Node version.
package audit

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/reqmeta"
	"vnpay/tabledb-api/internal/shared"
)

type Entry struct {
	ActorID      string // "" = none
	ActorLabel   string
	Action       string
	ResourceType string
	ResourceID   string
	IP           string // "" = none
	// Detail values must be JSON-marshalable. Absent optional fields must be left out (not nil) so the stored
	// document and the hashed one agree.
	Detail map[string]any
}

const Genesis = "0000000000000000000000000000000000000000000000000000000000000000"

// ---- canonical JSON, identical to canon() in audit.ts (JSON.stringify with sorted keys)

func jsQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[r>>4])
				b.WriteByte("0123456789abcdef"[r&0xf])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// jsNumber formats like JS Number.prototype.toString.
func jsNumber(f float64) string {
	if f == 0 || math.IsNaN(f) || math.IsInf(f, 0) {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return "null"
		}
		return "0"
	}
	a := math.Abs(f)
	if a >= 1e21 || a < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64) // 1e-07, 1.5e+21
		mant, exp, _ := strings.Cut(s, "e")
		sign := exp[0]
		exp = strings.TrimLeft(exp[1:], "0")
		return mant + "e" + string(sign) + exp
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

func canon(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return jsQuote(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return "null"
		}
		return jsNumber(f)
	case float64:
		return jsNumber(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = canon(e)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = jsQuote(k) + ":" + canon(x[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	return "null"
}

func strOrNull(s *string) string {
	if s == nil {
		return "null"
	}
	return jsQuote(*s)
}

func digest(prev, at string, actorID *string, actorLabel, action, resType, resID string, detail any) string {
	c := "[" + jsQuote(prev) + "," + jsQuote(at) + "," + strOrNull(actorID) + "," + jsQuote(actorLabel) + "," + jsQuote(action) + "," +
		jsQuote(resType) + "," + jsQuote(resID) + "," + canon(detail) + "]"
	h := sha256.Sum256([]byte(c))
	return hex.EncodeToString(h[:])
}

func decodeJSON(b []byte) any {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil
	}
	return v
}

func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Write appends an entry. Detail is redacted before storage; writers are serialized by an advisory lock.
func Write(ctx context.Context, q db.Runner, e Entry) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	at := isoMillis(now)
	e = withRequestMeta(ctx, e)
	detailJSON, err := json.Marshal(orEmpty(e.Detail))
	if err != nil {
		return err
	}
	detail := shared.RedactAudit(decodeJSON(detailJSON)) // normalized exactly as the DB will return it
	storedDetail, _ := json.Marshal(detail)
	var actor *string
	if e.ActorID != "" {
		a := e.ActorID
		actor = &a
	}
	var ip *string
	if e.IP != "" {
		i := e.IP
		ip = &i
	}
	// the actor must stay identifiable (e-mail kept); only secrets and control characters are removed
	label := shared.RedactSecrets(stripControl(e.ActorLabel))
	return q.InTx(ctx, func(t db.Runner) error {
		if _, err := t.Exec(ctx, "SELECT pg_advisory_xact_lock(727001)"); err != nil {
			return err
		}
		prev := Genesis
		var last string
		switch err := t.QueryRow(ctx, "SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").Scan(&last); {
		case err == nil:
			prev = last
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return err
		}
		hash := digest(prev, at, actor, label, e.Action, e.ResourceType, e.ResourceID, detail)
		_, err := t.Exec(ctx,
			`INSERT INTO audit_log (at, actor_id, actor_label, action, resource_type, resource_id, ip, detail, prev_hash, hash)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
			now, actor, label, e.Action, e.ResourceType, e.ResourceID, ip, string(storedDetail), prev, hash)
		return err
	})
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

type Verification struct {
	OK          bool  `json:"ok"`
	Checked     int   `json:"checked"`
	BrokenAtSeq int64 `json:"brokenAtSeq,omitempty"`
}

// Verify recomputes the whole chain.
func Verify(ctx context.Context, q db.Querier) (Verification, error) {
	rows, err := q.Query(ctx, `SELECT seq, at, actor_id::text, actor_label, action, resource_type, resource_id, detail::text, prev_hash, hash FROM audit_log ORDER BY seq`)
	if err != nil {
		return Verification{}, err
	}
	defer rows.Close()
	type row struct {
		seq            int64
		at             time.Time
		actor          *string
		label, action  string
		resType, resID string
		detail         string
		prevHash, hash string
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.seq, &r.at, &r.actor, &r.label, &r.action, &r.resType, &r.resID, &r.detail, &r.prevHash, &r.hash); err != nil {
			return Verification{}, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return Verification{}, err
	}
	prev := Genesis
	for _, r := range all {
		expect := digest(prev, isoMillis(r.at), r.actor, r.label, r.action, r.resType, r.resID, decodeJSON([]byte(r.detail)))
		if r.prevHash != prev || r.hash != expect {
			return Verification{OK: false, Checked: len(all), BrokenAtSeq: r.seq}, nil
		}
		prev = r.hash
	}
	return Verification{OK: true, Checked: len(all)}, nil
}

func stripControl(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029 {
			return -1
		}
		return r
	}, s)
}

// withRequestMeta adds the request trace fields (request id, user agent, proxy chain, session reference, client kind)
// to the detail and fills the IP when the caller did not. Existing keys are never overwritten.
func withRequestMeta(ctx context.Context, e Entry) Entry {
	m, ok := reqmeta.From(ctx)
	if !ok {
		return e
	}
	d := make(map[string]any, len(e.Detail)+5)
	for k, v := range e.Detail {
		d[k] = v
	}
	set := func(k, v string) {
		if v == "" {
			return
		}
		if _, exists := d[k]; !exists {
			d[k] = v
		}
	}
	set("requestId", m.RequestID)
	set("userAgent", m.UserAgent)
	set("xForwardedFor", m.XFF)
	set("sessionRef", m.SessionRef)
	set("clientKind", m.ClientKind)
	e.Detail = d
	if e.IP == "" {
		e.IP = m.IP
	}
	return e
}

// Canon returns the canonical JSON (sorted keys) that the chain and the manifest hash are computed over.
func Canon(v any) string { return canon(v) }

// CanonSHA256 is sha256(Canon(v)) in hex: a tamper-evident digest recomputable from the stored JSON.
func CanonSHA256(v any) string {
	h := sha256.Sum256([]byte(canon(v)))
	return hex.EncodeToString(h[:])
}

// DecodeJSON decodes with UseNumber so the value canonicalizes exactly like the chain does.
func DecodeJSON(b []byte) any { return decodeJSON(b) }
