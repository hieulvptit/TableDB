package routes

import (
	"encoding/csv"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/logsink"
	"vnpay/tabledb-api/internal/shared"
)

func (h *H) registerAudit(rt *app.Router) {
	d := h.D

	rt.GET("/audit", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := app.Need(r, "audit:read"); err != nil {
			return err
		}
		qs := r.URL.Query()
		var issues []shared.Issue
		bad := func(k, m string) { issues = append(issues, shared.Issue{Path: k, Message: m}) }
		var f audit.Filter
		if qs.Has("actor") {
			if v := qs.Get("actor"); shared.IsUUID(v) {
				f.ActorID = v
			} else {
				bad("actor", "Invalid uuid")
			}
		}
		if qs.Has("action") {
			a := qs.Get("action")
			if len(a) > 100 {
				bad("action", "String must contain at most 100 character(s)")
			}
			f.Action = a
		}
		for _, k := range []string{"actorEmail", "q"} { // substring of the actor label (e-mail)
			if qs.Has(k) {
				if v := strings.TrimSpace(qs.Get(k)); len(v) > 200 {
					bad(k, "String must contain at most 200 character(s)")
				} else if v != "" {
					f.ActorLike = v
				}
			}
		}
		if qs.Has("resourceId") {
			if v := qs.Get("resourceId"); len(v) > 200 {
				bad("resourceId", "String must contain at most 200 character(s)")
			} else {
				f.ResourceID = v
			}
		}
		if qs.Has("ticket") {
			if v := strings.TrimSpace(qs.Get("ticket")); !ticketCodeRe.MatchString(v) && v != "" {
				bad("ticket", "Invalid ticket code")
			} else {
				f.TicketCode = v
			}
		}
		for _, k := range []string{"from", "to"} {
			if qs.Has(k) {
				t, ok := parseDate(qs.Get(k))
				if !ok {
					bad(k, "Invalid date")
					continue
				}
				if k == "from" {
					f.From = &t
				} else {
					f.To = &t
				}
			}
		}
		limit := int64(100)
		if qs.Has("limit") {
			f, err := strconv.ParseFloat(strings.TrimSpace(qs.Get("limit")), 64)
			switch {
			case err != nil && strings.TrimSpace(qs.Get("limit")) != "":
				bad("limit", "Expected number, received nan")
			case f != float64(int64(f)):
				bad("limit", "Expected integer, received float")
			case f < 1:
				bad("limit", "Number must be greater than or equal to 1")
			case f > 500:
				bad("limit", "Number must be less than or equal to 500")
			default:
				limit = int64(f)
			}
		}
		if qs.Has("before") {
			v, err := strconv.ParseFloat(strings.TrimSpace(qs.Get("before")), 64)
			if err != nil || v != float64(int64(v)) {
				bad("before", "Expected integer")
			} else if v != 0 { // JS: `if (q.before)` — 0 is falsy
				f.Before = int64(v)
			}
		}
		if len(issues) > 0 {
			return &shared.ValidationError{Issues: issues}
		}
		entries, err := audit.List(r.Context(), d.DB, f, int(limit), true)
		if err != nil {
			return err
		}
		if entries == nil {
			entries = []audit.Row{}
		}
		app.WriteJSON(w, 200, map[string]any{"entries": entries})
		return nil
	})

	// Streamed export of a contiguous slice of the chain, with prevHash/hash so the file verifies offline (cmd/auditverify).
	rt.GET("/audit/export", app.Opts{Rate: &app.Rate{Max: 10, Window: time.Minute}}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "audit:read")
		if err != nil {
			return err
		}
		qs := r.URL.Query()
		var issues []shared.Issue
		var from, to *time.Time
		for _, k := range []string{"from", "to"} {
			if qs.Has(k) && qs.Get(k) != "" {
				t, ok := parseDate(qs.Get(k))
				if !ok {
					issues = append(issues, shared.Issue{Path: k, Message: "Invalid date"})
					continue
				}
				if k == "from" {
					from = &t
				} else {
					to = &t
				}
			}
		}
		format := "csv"
		if qs.Has("format") {
			format = qs.Get("format")
			if format != "csv" && format != "jsonl" {
				issues = append(issues, shared.Issue{Path: "format", Message: "Invalid enum value. Expected 'csv' | 'jsonl'"})
			}
		}
		if len(issues) > 0 {
			return &shared.ValidationError{Issues: issues}
		}
		ctx := r.Context()
		minSeq, maxSeq, err := audit.SeqRange(ctx, d.DB, from, to)
		if err != nil {
			return err
		}
		det := map[string]any{"format": format, "minSeq": minSeq, "maxSeq": maxSeq}
		if from != nil {
			det["from"] = app.ISO(*from)
		}
		if to != nil {
			det["to"] = app.ISO(*to)
		}
		// the export is itself an audited event (written before streaming, so the file does not contain its own entry)
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: "audit.export", ResourceType: "audit", ResourceID: "log", IP: d.ClientIP(r), Detail: det}); err != nil {
			return err
		}
		name := "audit-" + d.Now().UTC().Format("20060102T150405Z") + "." + format
		h := w.Header()
		h.Set("Content-Disposition", `attachment; filename="`+name+`"`)
		h.Set("Cache-Control", "no-store")
		if format == "jsonl" {
			h.Set("Content-Type", "application/x-ndjson; charset=utf-8")
		} else {
			h.Set("Content-Type", "text/csv; charset=utf-8")
		}
		w.WriteHeader(200)
		var write func(audit.Row) error
		flush := func() {}
		if fl, ok := w.(http.Flusher); ok {
			flush = fl.Flush
		}
		if format == "jsonl" {
			enc := json.NewEncoder(w)
			enc.SetEscapeHTML(false)
			write = func(row audit.Row) error { return enc.Encode(row) }
		} else {
			cw := csv.NewWriter(w)
			_ = cw.Write([]string{"seq", "at", "actor_id", "actor_label", "action", "resource_type", "resource_id", "ip", "detail", "prev_hash", "hash"})
			defer cw.Flush()
			write = func(row audit.Row) error {
				ai, ip := "", ""
				if row.ActorID != nil {
					ai = *row.ActorID
				}
				if row.IP != nil {
					ip = *row.IP
				}
				return cw.Write([]string{strconv.FormatInt(row.Seq, 10), row.At, ai, csvSafe(row.ActorLabel), csvSafe(row.Action), csvSafe(row.ResourceType), csvSafe(row.ResourceID), ip,
					string(row.Detail), row.PrevHash, row.Hash})
			}
		}
		n := 0
		if maxSeq > 0 {
			err = audit.Each(ctx, d.DB, minSeq, maxSeq, func(row audit.Row) error {
				n++
				if n%500 == 0 {
					flush()
				}
				return write(row)
			})
		}
		if err != nil {
			d.Log.Error("audit export interrupted", "err", err.Error(), "rows", n)
			return nil // headers are out; a short file fails offline verification, which is the signal
		}
		if from == nil && to == nil && maxSeq > 0 { // a complete copy of the chain left the server: its file copies may be rotated away later
			_ = logsink.WriteMarker(d.Cfg.LogDir, logsink.Marker{At: d.Now(), OK: true, ThroughSeq: maxSeq, Source: "export"})
		}
		return nil
	})

	rt.GET("/audit/verify", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := app.Need(r, "audit:read"); err != nil {
			return err
		}
		v, err := audit.Verify(r.Context(), d.DB)
		if err != nil {
			return err
		}
		if v.OK && v.Checked > 0 { // the DB chain is intact as of now: older rotated file copies may be pruned under disk pressure
			_ = logsink.WriteMarker(d.Cfg.LogDir, logsink.Marker{At: d.Now(), OK: true, ThroughSeq: int64(v.Checked), Source: "verify"})
		}
		app.WriteJSON(w, 200, v)
		return nil
	})
}

var ticketCodeRe = regexp.MustCompile(`^[A-Za-z0-9-]{3,40}$`)

// csvSafe neutralizes spreadsheet formula injection (=, +, -, @, tab, CR). Use the JSONL export for hash verification.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}
