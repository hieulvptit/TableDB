package routes

import (
	"encoding/json"
	"net/http"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/shared"
)

// The web BO has no database access. Database connections live ONLY in the desktop app (local JDBC sidecar).
// The server therefore cannot enforce SQL policy at execution time; it provides (1) the admin-approved target catalog
// and (2) an audit sink for the desktop. Enforcement is: DB account privileges + sidecar read-only/classifier.

type customEndpoint struct {
	Driver      string
	DriverName  *string
	Host        string
	Port        int64
	Database    *string
	ConnectType *string
	AllowWrite  bool
}

func (c *customEndpoint) detail() map[string]any {
	str := func(p *string) any {
		if p == nil {
			return nil
		}
		return *p
	}
	return map[string]any{"driver": c.Driver, "driverName": str(c.DriverName), "host": c.Host, "port": c.Port, "database": str(c.Database),
		"connectType": str(c.ConnectType), "allowWrite": c.AllowWrite}
}

// auditBody is the union of the two shapes accepted by POST /db/audit.
type auditBody struct {
	Activity map[string]any
	Context  map[string]any
	TargetID *string
	Custom   *customEndpoint

	IsEvent  bool
	Event    string
	AuthType *string
	Route    *string

	Mode      string
	SQL       string
	OK        bool
	Rows      *json.Number
	Ms        *json.Number
	ErrorCode *string
}

func parseWhere(o *shared.Obj, b *auditBody) {
	if id, ok := o.UUID("targetId", false); ok {
		b.TargetID = &id
	}
	if sub, ok := o.Sub("custom"); ok {
		c := &customEndpoint{}
		c.Driver, _ = sub.Enum("driver", true, "postgresql", "oracle", "trino", "custom")
		if v, ok := sub.String("driverName", false, 0, 64); ok {
			c.DriverName = &v
		}
		c.Host, _ = sub.String("host", true, 1, 253)
		c.Port, _ = sub.Int("port", true, 1, 65535, true)
		if v, ok := sub.String("database", false, 0, 128); ok {
			c.Database = &v
		}
		if v, ok := sub.Enum("connectType", false, "serviceName", "sid"); ok {
			c.ConnectType = &v
		}
		c.AllowWrite, _ = sub.Bool("allowWrite", true)
		o.Merge("custom", sub)
		b.Custom = c
	} else if o.Has("custom") && o.Raw("custom") != nil {
		o.Issues = append(o.Issues, shared.Issue{Path: "custom", Message: "Expected object"})
	}
}

func parseAuditBody(body []byte) (*auditBody, error) {
	// Activity events have a strict metadata whitelist; result data and secrets are ignored.
	probe := shared.DecodeObject(body)
	event, _ := probe.Raw("event").(string)
	if event == "table_view" || event == "export" {
		b := &auditBody{IsEvent: true, Event: event, Activity: map[string]any{}}
		parseWhere(probe, b)
		b.OK, _ = probe.Bool("ok", true)
		b.Activity["ok"] = b.OK
		for _, k := range []string{"catalog", "schema", "table"} {
			if v, ok := probe.String(k, event == "table_view" && k != "catalog", 1, 256); ok {
				b.Activity[k] = v
			}
		}
		if v, ok := probe.String("sql", false, 0, 200000); ok {
			b.Activity["sql"] = cut(shared.MaskSQL(v), 2000)
		}
		if event == "export" {
			v, _ := probe.Enum("format", true, "csv", "tsv", "json", "sql", "xlsx", "html", "markdown", "txt", "bin")
			b.Activity["format"] = v
			v, _ = probe.Enum("scope", true, "view", "all", "selection", "cell")
			b.Activity["scope"] = v
		}
		for _, k := range []string{"rows", "ms"} {
			if v, ok := probe.Int(k, false, 0, 0, false); ok {
				b.Activity[k] = v
			}
		}
		if v, ok := probe.String("errorCode", false, 0, 40); ok {
			b.Activity["errorCode"] = v
		}
		if err := probe.Err(); err != nil {
			return nil, err
		}
		if (b.TargetID == nil) == (b.Custom == nil) {
			return nil, apperr.Validation("exactly one of targetId or custom is required")
		}
		return b, nil
	}
	// variant 1: session event
	o1 := shared.DecodeObject(body)
	if len(o1.Issues) > 0 {
		return nil, o1.Err()
	}
	b1 := &auditBody{IsEvent: true}
	parseWhere(o1, b1)
	b1.Event, _ = o1.Enum("event", true, "open", "open_failed", "close")
	if v, ok := o1.Enum("authType", false, "password", "trino-external"); ok {
		b1.AuthType = &v
	}
	if v, ok := o1.String("route", false, 0, 300); ok {
		b1.Route = &v
	}
	var out *auditBody
	var firstErr error
	if len(o1.Issues) == 0 {
		out = b1
	} else {
		firstErr = o1.Err()
		// variant 2: query report
		o2 := shared.DecodeObject(body)
		b2 := &auditBody{Context: map[string]any{}}
		for _, k := range []string{"catalog", "schema", "table"} {
			if v, ok := o2.String(k, false, 1, 256); ok {
				b2.Context[k] = v
			}
		}
		parseWhere(o2, b2)
		b2.Mode, _ = o2.Enum("mode", true, "read", "write")
		b2.SQL, _ = o2.String("sql", true, 0, 200000)
		b2.OK, _ = o2.Bool("ok", true)
		if _, ok := o2.Int("rows", false, 0, 0, false); ok {
			n := o2.Raw("rows").(json.Number)
			b2.Rows = &n
		}
		if v := o2.Raw("ms"); v != nil {
			if n, ok := v.(json.Number); ok {
				if f, err := n.Float64(); err == nil && f >= 0 {
					b2.Ms = &n
				} else {
					o2.Issues = append(o2.Issues, shared.Issue{Path: "ms", Message: "Number must be greater than or equal to 0"})
				}
			} else {
				o2.Issues = append(o2.Issues, shared.Issue{Path: "ms", Message: "Expected number"})
			}
		}
		if v, ok := o2.String("errorCode", false, 0, 40); ok {
			b2.ErrorCode = &v
		}
		if len(o2.Issues) > 0 {
			return nil, firstErr // union failure
		}
		out = b2
	}
	if (out.TargetID == nil) == (out.Custom == nil) {
		return nil, &shared.ValidationError{Issues: []shared.Issue{{Path: "", Message: "exactly one of targetId or custom is required"}}}
	}
	return out, nil
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (h *H) registerDB(rt *app.Router) {
	d := h.D
	rt.GET("/db/config", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := app.Need(r, "db:connect"); err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		app.WriteJSON(w, 200, d.Cfg.DB)
		return nil
	})

	rt.GET("/db/targets", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := app.Need(r, "db:connect"); err != nil {
			return err
		}
		rows, err := d.DB.Query(r.Context(), `SELECT id::text, name, driver, host, port, database, allow_write, auth_modes, proxy, options FROM db_targets WHERE enabled ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		type target struct {
			ID            string   `json:"id"`
			Name          string   `json:"name"`
			Driver        string   `json:"driver"`
			Host          string   `json:"host"`
			Port          int      `json:"port"`
			Database      *string  `json:"database"`
			AllowWrite    bool     `json:"allowWrite"`
			AuthModes     []string `json:"authModes"`
			RequiresProxy bool     `json:"requiresProxy"`
			Proxy         any      `json:"proxy"`
			Options       any      `json:"options"`
		}
		out := []target{}
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.ID, &t.Name, &t.Driver, &t.Host, &t.Port, &t.Database, &t.AllowWrite, &t.AuthModes, &t.Proxy, &t.Options); err != nil {
				return err
			}
			t.RequiresProxy = t.Proxy != nil
			if t.Options == nil {
				t.Options = map[string]any{}
			}
			if t.AuthModes == nil {
				t.AuthModes = []string{}
			}
			out = append(out, t)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		app.WriteJSON(w, 200, out)
		return nil
	})

	rt.POST("/db/audit", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		body, err := app.ReadBody(w, r, app.JSONBodyLimit)
		if err != nil {
			return err
		}
		// authenticate/authorize before validating the body (401/403 win over 400)
		perm := shared.Permission("db:connect")
		if probe := shared.DecodeObject(body); len(probe.Issues) == 0 && probe.Has("custom") {
			perm = "db:custom"
		}
		a, err := app.Need(r, perm)
		if err != nil {
			return err
		}
		b, err := parseAuditBody(body)
		if err != nil {
			return err
		}
		ctx := r.Context()
		ip := d.ClientIP(r)
		str := func(p *string) any {
			if p == nil {
				return nil
			}
			return *p
		}
		queryDetail := func(base map[string]any, c shared.SqlClassification) map[string]any {
			base["mode"], base["kind"], base["multi"] = b.Mode, string(c.Kind), c.Multi
			base["sql"] = cut(shared.MaskSQL(b.SQL), 2000)
			base["ok"] = b.OK
			// optional fields are left out when absent (not null) so the stored document and its hash agree
			if b.Rows != nil {
				base["rows"] = *b.Rows
			}
			if b.Ms != nil {
				base["ms"] = *b.Ms
			}
			if b.ErrorCode != nil {
				base["errorCode"] = *b.ErrorCode
			}
			for k, v := range b.Context {
				base[k] = v
			}
			base["reportedBy"] = "desktop"
			return base
		}
		writeActivity := func(base map[string]any, prefix, resType, resID string) error {
			for k, v := range b.Activity {
				base[k] = v
			}
			base["reportedBy"] = "desktop"
			if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: prefix + b.Event, ResourceType: resType, ResourceID: resID, IP: ip, Detail: base}); err != nil {
				return err
			}
			app.WriteJSON(w, 200, map[string]any{"ok": true})
			return nil
		}
		if b.Custom != nil {
			ep := b.Custom.detail()
			if b.Activity != nil {
				return writeActivity(map[string]any{"endpoint": ep}, "db.custom.", "db_custom", "")
			}
			if b.IsEvent {
				err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: "db.custom.session." + b.Event, ResourceType: "db_custom", IP: ip,
					Detail: map[string]any{"endpoint": ep, "authType": str(b.AuthType), "route": str(b.Route), "reportedBy": "desktop"}})
				if err != nil {
					return err
				}
				app.WriteJSON(w, 200, map[string]any{"ok": true})
				return nil
			}
			cc := shared.ClassifySQL(b.SQL)
			bad := b.Mode == "write" && (!shared.HasPermission(&a.Principal, "db:write") || !b.Custom.AllowWrite) || b.Mode == "read" && cc.Kind != shared.SqlRead
			action := "db.custom.query"
			if bad {
				action = "db.custom.query.policy_violation"
			}
			if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: action, ResourceType: "db_custom", IP: ip,
				Detail: queryDetail(map[string]any{"endpoint": ep}, cc)}); err != nil {
				return err
			}
			app.WriteJSON(w, 200, map[string]any{"ok": true})
			return nil
		}

		var tid, tname string
		var allowWrite bool
		var driver, host string
		var port int
		var database *string
		err = d.DB.QueryRow(ctx, "SELECT id::text, name, allow_write, driver, host, port, database FROM db_targets WHERE id=$1", *b.TargetID).Scan(&tid, &tname, &allowWrite, &driver, &host, &port, &database)
		if err != nil {
			if dbNoRows(err) {
				return apperr.Validation("unknown target")
			}
			return err
		}
		endpoint := map[string]any{"driver": driver, "host": host, "port": port, "database": str(database)}
		if b.Activity != nil {
			return writeActivity(map[string]any{"target": tname, "endpoint": endpoint}, "db.", "db_target", tid)
		}
		if b.IsEvent {
			err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: "db.session." + b.Event, ResourceType: "db_target", ResourceID: tid, IP: ip,
				Detail: map[string]any{"target": tname, "endpoint": endpoint, "authType": str(b.AuthType), "route": str(b.Route), "reportedBy": "desktop"}})
			if err != nil {
				return err
			}
			app.WriteJSON(w, 200, map[string]any{"ok": true})
			return nil
		}
		c := shared.ClassifySQL(b.SQL)
		// the server cannot block, but it flags anything that contradicts policy so it is visible to auditors
		violation := b.Mode == "write" && (!shared.HasPermission(&a.Principal, "db:write") || !allowWrite) || b.Mode == "read" && c.Kind != shared.SqlRead
		action := "db.query"
		if violation {
			action = "db.query.policy_violation"
		}
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: action, ResourceType: "db_target", ResourceID: tid, IP: ip,
			Detail: queryDetail(map[string]any{"target": tname, "endpoint": endpoint}, c)}); err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}
