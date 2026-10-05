package apitest

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"vnpay/tabledb-api/internal/audit"
)

func TestDBRoutes(t *testing.T) {
	h := harness(t)
	admin, alice, bob := h.User("admin@vnpay.vn"), h.User("alice@vnpay.vn"), h.User("bob@vnpay.vn")
	_ = admin
	app := "app"
	svc := "SVC"
	target := h.AddTarget("PG-test", "postgresql", "db.internal", 5432, &app, true, nil, nil)
	roTarget := h.AddTarget("ORA-ro", "oracle", "ora.internal", 1521, &svc, false, nil, nil)
	h.AddTarget("TRINO", "trino", "trino.internal", 8443, nil, false, []string{"trino-external"}, map[string]any{"type": "http", "host": "proxy", "port": 3128})

	t.Run("database session/rpc routes do not exist", func(t *testing.T) {
		for _, c := range [][2]string{{"POST", "/db/sessions"}, {"POST", "/db/sessions/x/rpc"}, {"GET", "/db/profiles"}, {"GET", "/db/sessions/x/events"}} {
			eq(t, alice.Req(c[0], c[1], Opt{Body: map[string]any{}}).Status, 404, c[1])
		}
	})
	t.Run("catalog lists enabled targets (no secrets) and needs db:connect", func(t *testing.T) {
		r := alice.Get("/db/targets")
		status(t, r, 200, "targets")
		var names []string
		for _, x := range r.JSON().([]any) {
			names = append(names, x.(map[string]any)["name"].(string))
		}
		eq(t, strings.Join(names, ","), "ORA-ro,PG-test,TRINO", "names")
		if regexp.MustCompile(`(?i)"(password|secret|token|credential)\w*":`).Match(r.Body) {
			t.Fatal("secrets in catalog")
		}
		var trino map[string]any
		var pg map[string]any
		for _, x := range r.JSON().([]any) {
			switch x.(map[string]any)["name"] {
			case "TRINO":
				trino = x.(map[string]any)
			case "PG-test":
				pg = x.(map[string]any)
			}
		}
		pj, _ := json.Marshal(trino["proxy"])
		eq(t, string(pj), `{"host":"proxy","port":3128,"type":"http"}`, "trino proxy")
		eq(t, trino["requiresProxy"], true, "requiresProxy")
		eq(t, pg["requiresProxy"], false, "pg requiresProxy")
		eq(t, pg["allowWrite"], true, "allowWrite")
		eq(t, pg["database"], "app", "database")
		if pg["proxy"] != nil {
			t.Fatal("proxy must be null")
		}
		h.Exec("UPDATE db_targets SET enabled=false WHERE name='TRINO'")
		for _, x := range alice.Get("/db/targets").JSON().([]any) {
			if x.(map[string]any)["name"] == "TRINO" {
				t.Fatal("disabled target listed")
			}
		}
		u := h.User("svc@vnpay.vn")
		h.SetUser(u.ID, UserSet{Roles: []string{"service"}})
		status(t, u.Get("/db/targets"), 403, "service principal")
	})
	t.Run("custom (ad-hoc) connections: db:custom is a default permission and audited separately", func(t *testing.T) {
		q := func(c *Client, body map[string]any) *Resp { return c.Post("/db/audit", body) }
		last := func() (action, resType string, detail map[string]any) {
			var raw string
			if err := h.DB.QueryRow(ctxBG(), "SELECT action, resource_type, detail::text FROM audit_log WHERE action LIKE 'db.custom.%' ORDER BY seq DESC LIMIT 1").Scan(&action, &resType, &raw); err != nil {
				t.Fatal(err)
			}
			_ = json.Unmarshal([]byte(raw), &detail)
			return
		}
		ep := map[string]any{"driver": "oracle", "host": "ora.internal", "port": 1521, "database": "BISVC", "connectType": "serviceName", "allowWrite": false}
		with := func(extra map[string]any) map[string]any {
			m := map[string]any{"custom": ep}
			for k, v := range extra {
				m[k] = v
			}
			return m
		}
		status(t, q(alice, with(map[string]any{"event": "open", "authType": "password"})), 200, "open")
		a, rt, d := last()
		eq(t, a, "db.custom.session.open", "action")
		eq(t, rt, "db_custom", "resource type")
		endpoint := d["endpoint"].(map[string]any)
		if endpoint["host"] != "ora.internal" || endpoint["port"] != float64(1521) || endpoint["database"] != "BISVC" || endpoint["connectType"] != "serviceName" {
			t.Fatalf("endpoint %v", endpoint)
		}
		if d["route"] != nil {
			t.Fatalf("route should be null: %v", d["route"])
		}
		status(t, q(alice, with(map[string]any{"event": "open", "authType": "password", "route": "SSH bastion:22 → 10.0.0.5:22"})), 200, "open with route")
		_, _, d = last()
		eq(t, d["route"], "SSH bastion:22 → 10.0.0.5:22", "route")
		status(t, q(alice, with(map[string]any{"event": "open", "route": strings.Repeat("x", 301)})), 400, "route too long")
		q(alice, with(map[string]any{"mode": "read", "sql": "select * from t where id=42", "ok": true}))
		a, _, _ = last()
		eq(t, a, "db.custom.query", "read ok")
		q(alice, with(map[string]any{"mode": "write", "sql": "DELETE FROM t", "ok": true}))
		a, _, _ = last()
		eq(t, a, "db.custom.query.policy_violation", "write without db:write")
		q(alice, with(map[string]any{"mode": "read", "sql": "DELETE FROM t", "ok": true}))
		a, _, _ = last()
		eq(t, a, "db.custom.query.policy_violation", "DML in read mode")
		status(t, q(alice, with(map[string]any{"targetId": target, "event": "open"})), 400, "both targetId and custom")
		status(t, q(alice, map[string]any{"event": "open"}), 400, "neither")
		bad := map[string]any{"driver": "oracle", "host": "h", "port": 0, "allowWrite": false}
		status(t, q(alice, map[string]any{"custom": bad, "event": "open"}), 400, "port 0")
		// the chain stays verifiable after all those writes (optional fields are omitted, not null)
		v, err := audit.Verify(ctxBG(), h.DB)
		if err != nil || !v.OK {
			t.Fatalf("chain: %+v %v", v, err)
		}
	})
	t.Run("desktop audit sink masks literals, records session events, and flags policy contradictions", func(t *testing.T) {
		q := func(c *Client, body map[string]any) *Resp { return c.Post("/db/audit", body) }
		status(t, q(alice, map[string]any{"targetId": target, "mode": "read", "sql": "select * from cust where phone='0912345678' and id=42", "ok": true, "rows": 3, "ms": 10}), 200, "read")
		last := func() (action string, detail map[string]any) {
			var raw string
			if err := h.DB.QueryRow(ctxBG(), "SELECT action, detail::text FROM audit_log WHERE action LIKE 'db.%' ORDER BY seq DESC LIMIT 1").Scan(&action, &raw); err != nil {
				t.Fatal(err)
			}
			_ = json.Unmarshal([]byte(raw), &detail)
			return
		}
		a, d := last()
		eq(t, a, "db.query", "action")
		eq(t, d["sql"], "select * from cust where phone=? and id=?", "masked sql")
		if strings.Contains(mustJSON(d), "0912345678") {
			t.Fatal("literal leaked")
		}
		eq(t, d["reportedBy"], "desktop", "reportedBy")
		eq[any](t, d["rows"], float64(3), "rows")
		q(alice, map[string]any{"targetId": target, "mode": "read", "sql": "DELETE FROM t", "ok": true})
		a, _ = last()
		eq(t, a, "db.query.policy_violation", "DML in read mode")
		q(alice, map[string]any{"targetId": target, "mode": "write", "sql": "DELETE FROM t", "ok": true})
		a, _ = last()
		eq(t, a, "db.query.policy_violation", "write without db:write")
		h.SetUser(bob.ID, UserSet{Roles: []string{"user"}, Grants: []string{"db:write"}})
		q(bob, map[string]any{"targetId": target, "mode": "write", "sql": "DELETE FROM t", "ok": true})
		a, _ = last()
		eq(t, a, "db.query", "write allowed")
		q(bob, map[string]any{"targetId": roTarget, "mode": "write", "sql": "DELETE FROM t", "ok": true})
		a, _ = last()
		eq(t, a, "db.query.policy_violation", "read-only target")
		q(alice, map[string]any{"targetId": target, "event": "open_failed", "authType": "password"})
		a, _ = last()
		eq(t, a, "db.session.open_failed", "open_failed")
		status(t, q(alice, map[string]any{"targetId": "00000000-0000-0000-0000-000000000000", "event": "open"}), 400, "unknown target")
		status(t, h.Anon("POST", "/db/audit", Opt{Body: map[string]any{}}), 401, "anonymous")
		v, err := audit.Verify(ctxBG(), h.DB)
		if err != nil || !v.OK {
			t.Fatalf("chain: %+v %v", v, err)
		}
	})
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
