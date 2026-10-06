package apitest

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDBActivityAudit(t *testing.T) {
	h := harness(t)
	user := h.User("activity@vnpay.vn")
	database := "app"
	target := h.AddTarget("PG-audit", "postgresql", "db.internal", 5432, &database, false, nil, nil)
	for _, custom := range []bool{false, true} {
		for _, event := range []string{"table_view", "export"} {
			body := map[string]any{"event": event, "ok": true, "catalog": "app", "schema": "public", "table": "orders", "sql": "SELECT * FROM public.orders WHERE password='secret-value'", "rows": 2, "data": []any{"secret-value"}, "token": "secret-token", "actorId": "spoofed", "format": "xlsx", "scope": "selection"}
			prefix := "db."
			if custom {
				prefix = "db.custom."
				body["custom"] = map[string]any{"driver": "postgresql", "host": "custom.internal", "port": 5432, "database": "app", "allowWrite": false}
			} else {
				body["targetId"] = target
			}
			status(t, user.Post("/db/audit", body), 200, event)
			var actor, action, raw string
			if err := h.DB.QueryRow(ctxBG(), "SELECT actor_id::text, action, detail::text FROM audit_log ORDER BY seq DESC LIMIT 1").Scan(&actor, &action, &raw); err != nil {
				t.Fatal(err)
			}
			eq(t, actor, user.ID, "authenticated actor")
			eq(t, action, prefix+event, "action")
			if strings.Contains(raw, "secret-value") || strings.Contains(raw, "secret-token") || strings.Contains(raw, "spoofed") {
				t.Fatalf("sensitive data in audit: %s", raw)
			}
			var detail map[string]any
			if err := json.Unmarshal([]byte(raw), &detail); err != nil {
				t.Fatal(err)
			}
			eq(t, detail["table"], "orders", "table")
			eq(t, detail["schema"], "public", "schema")
			if _, ok := detail["endpoint"].(map[string]any); !ok {
				t.Fatal("missing DB endpoint")
			}
			body["rows"] = -1
			status(t, user.Post("/db/audit", body), 400, "negative count")
			delete(body, "rows")
			if event == "export" {
				body["format"] = "unknown"
			} else {
				delete(body, "table")
			}
			status(t, user.Post("/db/audit", body), 400, "invalid event metadata")
		}
	}
	admin := h.User("admin@vnpay.vn")
	eq(t, admin.Get("/audit/verify").Get("ok"), true, "hash chain")
}
