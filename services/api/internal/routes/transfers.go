package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/hrm"
	"vnpay/tabledb-api/internal/shared"
)

type leaderOut struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Title string `json:"title,omitempty"`
}

// coerceDate mirrors z.coerce.date() for the inputs we accept: RFC3339, date-only, datetime without zone (UTC), epoch millis.
func coerceDate(o *shared.Obj, k string) (time.Time, bool) {
	v := o.Raw(k)
	var t time.Time
	switch x := v.(type) {
	case nil:
		o.Issues = append(o.Issues, shared.Issue{Path: k, Message: "Required"})
		return t, false
	case string:
		t, ok := parseDate(x)
		if !ok {
			o.Issues = append(o.Issues, shared.Issue{Path: k, Message: "Invalid date"})
		}
		return t, ok
	case json.Number:
		f, err := x.Float64()
		if err == nil {
			return time.UnixMilli(int64(f)), true
		}
	}
	o.Issues = append(o.Issues, shared.Issue{Path: k, Message: "Invalid date"})
	return t, false
}

func parseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return time.UnixMilli(int64(f)), true
	}
	return time.Time{}, false
}

func (h *H) registerTransfers(rt *app.Router) {
	h.registerEmailApproval(rt)
	d := h.D
	T := d.Tickets
	jsonBody := func(w http.ResponseWriter, r *http.Request) ([]byte, error) {
		return app.ReadBody(w, r, app.JSONBodyLimit)
	}

	rt.GET("/transfers/options", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		me, err := app.Need(r, "transfer:create")
		if err != nil {
			return err
		}
		ctx := r.Context()
		leaders := []leaderOut{}
		if d.Cfg.HRMConfigured() {
			managers, err := d.HRM.ManagersOf(ctx, me.Email)
			if err != nil {
				return err
			}
			local, err := hrm.EnsureLeaderUsers(ctx, d.DB, managers)
			if err != nil {
				return err
			}
			for _, m := range managers {
				u, ok := local[m.Email]
				if !ok || !u.Active || u.ID == me.Principal.ID {
					continue
				}
				leaders = append(leaders, leaderOut{ID: u.ID, Name: u.Name, Email: m.Email, Title: m.JobTitleName})
			}
		} else {
			// dev/test without HRM: locally configured leaders table (prod refuses to start without HRM)
			rows, err := d.DB.Query(ctx, `SELECT u.id::text, u.name, u.email FROM leaders l JOIN users u ON u.id=l.user_id JOIN role_assignments ra ON ra.user_id=u.id AND ra.role='leader'
				WHERE l.enabled AND u.active AND u.id <> $1 ORDER BY u.name`, me.Principal.ID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var l leaderOut
				if err := rows.Scan(&l.ID, &l.Name, &l.Email); err != nil {
					return err
				}
				leaders = append(leaders, l)
			}
			if err := rows.Err(); err != nil {
				return err
			}
		}
		exts := d.Cfg.AllowedExtensions
		if exts == nil {
			exts = []string{}
		}
		app.WriteJSON(w, 200, map[string]any{"leaders": leaders, "limits": map[string]any{
			"maxBytes": d.Cfg.MaxUploadBytes, "partBytes": d.Cfg.PartBytes, "allowedExtensions": exts,
			"defaultTtlHours": d.Cfg.TicketTTLHours, "maxDownloads": d.Cfg.MaxDownloads}, "upload": d.Cfg.UploadClient, "approval": map[string]any{"windowHours": d.Cfg.ApprovalWindowHours, "delegationMaxDays": d.Cfg.DelegationMaxDays}, "download": map[string]any{"tokenTtlSec": d.Cfg.DownloadTokenTTLSec, "reauthMaxAgeSec": d.Cfg.DownloadReauthMaxAgeSec}})
		return nil
	})

	rt.POST("/transfers", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:create")
		if err != nil {
			return err
		}
		body, err := jsonBody(w, r)
		if err != nil {
			return err
		}
		in, err := shared.ParseUploadInit(body)
		if err != nil {
			return err
		}
		res, err := T.CreateTicket(r.Context(), a, in, d.ClientIP(r))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 201, res)
		return nil
	})

	rt.GET("/transfers", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		q := r.URL.Query()
		view := "sent"
		if q.Has("view") {
			view = q.Get("view")
			switch view {
			case "sent", "inbox", "approvals", "all":
			default:
				return &shared.ValidationError{Issues: []shared.Issue{{Path: "view", Message: "Invalid enum value. Expected 'sent' | 'inbox' | 'approvals' | 'all'"}}}
			}
		}
		list, err := T.ListTickets(r.Context(), a, view, q.Get("status"))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"tickets": list})
		return nil
	})

	rt.GET("/transfers/{id}", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		res, err := T.GetTicketFor(r.Context(), a, r.PathValue("id"))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, res)
		return nil
	})

	rt.PUT("/transfers/{id}/parts/{n}", app.Opts{Rate: &app.Rate{Max: 600, Window: time.Minute}}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:create")
		if err != nil {
			return err
		}
		if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/octet-stream" {
			return apperr.Validation("body must be application/octet-stream")
		}
		body, err := app.ReadBody(w, r, d.Cfg.PartBytes+1024)
		if err != nil {
			return err
		}
		n, convErr := strconv.Atoi(r.PathValue("n"))
		if convErr != nil {
			n = -1
		}
		res, err := T.PutPart(r.Context(), a, r.PathValue("id"), n, body, r.Header.Get("X-Part-SHA256"))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, res)
		return nil
	})

	rt.POST("/transfers/{id}/complete", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:create")
		if err != nil {
			return err
		}
		res, err := T.CompleteUpload(r.Context(), a, r.PathValue("id"), r.Header.Get("Idempotency-Key"), d.ClientIP(r))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, res)
		return nil
	})

	rt.POST("/transfers/{id}/abort", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:create")
		if err != nil {
			return err
		}
		if err := T.AbortUpload(r.Context(), a, r.PathValue("id"), d.ClientIP(r)); err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ok": true})
		return nil
	})

	rt.POST("/transfers/{id}/decision", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:approve")
		if err != nil {
			return err
		}
		body, err := jsonBody(w, r)
		if err != nil {
			return err
		}
		b, err := shared.ParseDecisionBody(body)
		if err != nil {
			return err
		}
		t, err := T.Decide(r.Context(), a, r.PathValue("id"), b.Decision, b.Reason, d.ClientIP(r))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ticket": t})
		return nil
	})

	rt.POST("/transfers/{id}/revoke", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		body, err := jsonBody(w, r)
		if err != nil {
			return err
		}
		var reason *string
		if len(strings.TrimSpace(string(body))) > 0 { // z.object({reason}).parse(req.body ?? {})
			o := shared.DecodeObject(body)
			if rs, ok := o.String("reason", false, 0, 500); ok {
				reason = &rs
			}
			if err := o.Err(); err != nil {
				return err
			}
		}
		t, err := T.Revoke(r.Context(), a, r.PathValue("id"), reason, d.ClientIP(r))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ticket": t})
		return nil
	})

	rt.POST("/transfers/{id}/change-approver", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "admin:manage")
		if err != nil {
			return err
		}
		body, err := jsonBody(w, r)
		if err != nil {
			return err
		}
		o := shared.DecodeObject(body)
		approver, _ := o.UUID("approverId", true)
		if err := o.Err(); err != nil {
			return err
		}
		t, err := T.ChangeApprover(r.Context(), a, r.PathValue("id"), approver, d.ClientIP(r))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ticket": t})
		return nil
	})

	dlRate := &app.Rate{Max: d.Cfg.DownloadRateLimitPerMin, Window: time.Minute}
	rt.POST("/transfers/{id}/download-token", app.Opts{Rate: dlRate}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:download")
		if err != nil {
			return err
		}
		id := r.PathValue("id")
		tok, exp, err := T.IssueDownloadToken(r.Context(), a, id, d.ClientIP(r)) // STEPUP_REQUIRED also sets X-Stepup (WriteError)
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{
			"url":          fmt.Sprintf("%s/api/v1/transfers/%s/download?t=%s", d.Cfg.PublicURL, id, app.EncodeURIComponent(tok)),
			"expiresInSec": exp})
		return nil
	})

	rt.GET("/transfers/{id}/download", app.Opts{Rate: dlRate}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:download")
		if err != nil {
			return err
		}
		dl, err := T.OpenDownload(r.Context(), a, r.PathValue("id"), r.URL.Query().Get("t"), d.ClientIP(r))
		if err != nil {
			return err
		}
		hd := w.Header()
		hd.Set("Content-Type", "application/octet-stream")
		hd.Set("Content-Disposition", "attachment; filename*=UTF-8''"+app.EncodeURIComponent(dl.FileName))
		hd.Set("Content-Length", strconv.FormatInt(dl.Size, 10))
		hd.Set("X-Content-SHA256", dl.SHA256)
		hd.Set("Cache-Control", "no-store")
		hd.Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		// hash what is actually written so the trail can say whether the client received the recorded bytes
		h := sha256.New()
		cw := &countWriter{w: io.MultiWriter(w, h)}
		_, cerr := io.Copy(cw, dl.Body)
		if cerr != nil {
			// headers are out: the truncated body (length mismatch) tells the client the download failed
			d.Log.Error("download stream failed", "err", cerr.Error())
		}
		T.FinishDownload(r.Context(), a, dl, d.ClientIP(r), cw.n, hex.EncodeToString(h.Sum(nil)), cerr)
		return nil
	})

	rt.GET("/transfers/{id}/manifest", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		q := r.URL.Query()
		offset, limit := 0, 100
		var issues []shared.Issue
		num := func(k string, dst *int, min, max int) {
			if !q.Has(k) {
				return
			}
			n, err := strconv.Atoi(q.Get(k))
			if err != nil || n < min || n > max {
				issues = append(issues, shared.Issue{Path: k, Message: fmt.Sprintf("Expected integer between %d and %d", min, max)})
				return
			}
			*dst = n
		}
		num("offset", &offset, 0, 1<<30)
		num("limit", &limit, 1, 500)
		if len(issues) > 0 {
			return &shared.ValidationError{Issues: issues}
		}
		v, err := T.GetManifest(r.Context(), a, r.PathValue("id"), offset, limit, q.Get("verify") == "1")
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, v)
		return nil
	})

	rt.GET("/transfers/{id}/trace", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		v, err := T.GetTrace(r.Context(), a, r.PathValue("id"))
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, v)
		return nil
	})

	// delegations: a leader hands approval authority to someone for a bounded time
	rt.GET("/delegations", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:approve")
		if err != nil {
			return err
		}
		rows, err := d.DB.Query(r.Context(), `SELECT id::text, to_user_id::text, valid_from, valid_to, revoked FROM delegations WHERE from_user_id=$1 ORDER BY created_at DESC`, a.Principal.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		type dg struct {
			ID        string `json:"id"`
			ToUserID  string `json:"toUserId"`
			ValidFrom string `json:"validFrom"`
			ValidTo   string `json:"validTo"`
			Revoked   bool   `json:"revoked"`
		}
		out := []dg{}
		for rows.Next() {
			var x dg
			var vf, vt time.Time
			if err := rows.Scan(&x.ID, &x.ToUserID, &vf, &vt, &x.Revoked); err != nil {
				return err
			}
			x.ValidFrom, x.ValidTo = app.ISO(vf), app.ISO(vt)
			out = append(out, x)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"delegations": out})
		return nil
	})

	rt.POST("/delegations", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:approve")
		if err != nil {
			return err
		}
		body, err := jsonBody(w, r)
		if err != nil {
			return err
		}
		o := shared.DecodeObject(body)
		to, _ := o.UUID("toUserId", true)
		from, okFrom := coerceDate(o, "validFrom")
		until, okTo := coerceDate(o, "validTo")
		if len(o.Issues) > 0 || !okFrom || !okTo {
			return o.Err()
		}
		if strings.EqualFold(to, a.Principal.ID) {
			return apperr.Validation("cannot delegate to yourself")
		}
		if !until.After(from) || until.Sub(from) > time.Duration(d.Cfg.DelegationMaxDays)*24*time.Hour {
			return apperr.Validation(fmt.Sprintf("invalid delegation window (max %d days)", d.Cfg.DelegationMaxDays))
		}
		ctx := r.Context()
		var one string
		if err := d.DB.QueryRow(ctx, "SELECT u.id::text FROM users u JOIN role_assignments ra ON ra.user_id=u.id AND ra.role='leader' WHERE u.id=$1 AND u.active", to).Scan(&one); err != nil {
			if dbNoRows(err) {
				return apperr.Validation("delegate must be an active leader")
			}
			return err
		}
		var id string
		if err := d.DB.QueryRow(ctx, "INSERT INTO delegations (from_user_id, to_user_id, valid_from, valid_to) VALUES ($1,$2,$3,$4) RETURNING id::text", a.Principal.ID, to, from, until).Scan(&id); err != nil {
			return err
		}
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: "delegation.create", ResourceType: "user", ResourceID: to, IP: d.ClientIP(r),
			Detail: map[string]any{"validFrom": app.ISO(from), "validTo": app.ISO(until), "delegator": T.Person(ctx, d.DB, a.Principal.ID), "delegate": T.Person(ctx, d.DB, to), "delegationId": id}}); err != nil {
			return err
		}
		app.WriteJSON(w, 201, map[string]any{"id": id})
		return nil
	})

	rt.DELETE("/delegations/{id}", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "transfer:approve")
		if err != nil {
			return err
		}
		id := r.PathValue("id")
		if !shared.IsUUID(id) {
			return apperr.NotFound("not found")
		}
		tag, err := d.DB.Exec(r.Context(), "UPDATE delegations SET revoked=true WHERE id=$1 AND from_user_id=$2", id, a.Principal.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apperr.NotFound("not found")
		}
		if err := audit.Write(r.Context(), d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: "delegation.revoke", ResourceType: "delegation", ResourceID: id, IP: d.ClientIP(r),
			Detail: map[string]any{"delegator": T.Person(r.Context(), d.DB, a.Principal.ID), "delegationId": id}}); err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
