package apitest

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The Agent runs in desktop; server provides deployment config and audit.
func TestAgentAudit(t *testing.T) {
	h := harness(t)
	alice := h.User("alice@vnpay.vn")
	t.Run("desktop bootstrap configuration is available before login", func(t *testing.T) {
		r := h.Anon("GET", "/desktop/config")
		status(t, r, 200, "desktop config")
		eq(t, r.Get("genaiInternalConnectPort").(float64), 47613.0, "callback port")
		eq(t, obj(r.Get("sidecar"))["maxHeapMb"].(float64), 512.0, "heap")
	})
	last := func(action string) (map[string]any, string, string) {
		h.T.Helper()
		var raw []byte
		var rtype, rid string
		if err := h.DB.QueryRow(context.Background(), "SELECT detail, coalesce(resource_type,''), coalesce(resource_id,'') FROM audit_log WHERE action=$1 ORDER BY seq DESC LIMIT 1", action).Scan(&raw, &rtype, &rid); err != nil {
			h.T.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		return m, rtype, rid
	}

	t.Run("serves deployment config only to authenticated Agent users", func(t *testing.T) {
		eq(t, h.Anon("GET", "/agent/config").Status, 401, "anonymous config")
		r := alice.Req("GET", "/agent/config")
		status(t, r, 200, "agent config")
		eq(t, r.Str("defaultModel"), "v_kimi", "default model")
		endpoints := r.Get("endpoints").([]any)
		eq(t, len(endpoints), 2, "endpoint count")
		eq(t, obj(endpoints[0])["baseUrl"].(string), "https://genai.vnpay.vn/aigateway/llm_kimi/v1", "base URL")
	})

	t.Run("agent routes of the old server-side Agent are gone", func(t *testing.T) {
		for _, c := range [][2]string{{"POST", "/agent/chat"}, {"POST", "/agent/chat/stream"}, {"POST", "/agent/context-preview"}, {"GET", "/agent/settings"}, {"PUT", "/agent/token"}, {"GET", "/agent/openmetadata/token"}} {
			eq(t, alice.Req(c[0], c[1], Opt{Body: map[string]any{}}).Status, 404, c[0]+" "+c[1])
		}
	})

	t.Run("needs a session and agent:use", func(t *testing.T) {
		eq(t, h.Anon("POST", "/agent/audit", Opt{Body: map[string]any{"action": "agent.chat"}}).Status, 401, "anon")
	})

	t.Run("records a chat entry without prompt/reply/credential fields; marks it reportedBy=desktop", func(t *testing.T) {
		r := alice.Post("/agent/audit", map[string]any{
			"action": "agent.chat", "connectionId": "profile-1", "ok": true, "endpointId": "vnpay-kimi", "model": "v_kimi", "promptChars": 1200, "replyChars": 300,
			"tables": []any{"public.orders"}, "suggestedSql": []any{"read"}, "images": 0,
			"harness":      map[string]any{"llmCalls": 3, "toolCalls": 2, "trace": []any{"0:tool:load_skill:ok"}},
			"openMetadata": map[string]any{"available": true, "used": false},
			// must never be stored
			"prompt": "SELECT secret FROM x", "reply": "answer text", "token": "tok-ABCDEFGH", "sql": "DELETE FROM t", "messages": []any{"hi"},
		})
		status(t, r, 201, "audit")
		d, rtype, rid := last("agent.chat")
		eq(t, rtype+"/"+rid, "connection/profile-1", "resource")
		eq(t, d["reportedBy"].(string), "desktop", "reportedBy")
		eq(t, d["model"].(string), "v_kimi", "model")
		eq(t, d["promptChars"].(float64), 1200.0, "promptChars")
		eq(t, obj(d["harness"])["llmCalls"].(float64), 3.0, "harness")
		s, _ := json.Marshal(d)
		for _, bad := range []string{"SELECT secret", "answer text", "tok-ABCDEFGH", "DELETE FROM t", `"prompt"`, `"token"`, `"messages"`} {
			if strings.Contains(string(s), bad) {
				t.Fatalf("%q stored: %s", bad, s)
			}
		}
	})

	t.Run("keeps redacted question/answer and masked proposed SQL; the server redacts and masks again", func(t *testing.T) {
		status(t, alice.Post("/agent/audit", map[string]any{"action": "agent.chat", "connectionId": "p2", "ok": true,
			"question": "mail tôi a@b.co thẻ 4111 1111 1111 1111", "answer": "ok " + strings.Repeat("x", 5000),
			"sqlMasked": []any{"SELECT * FROM t WHERE phone = '0912345678'", "b", "c", "d", "e", "f"}}), 201, "qa")
		d, _, _ := last("agent.chat")
		q := d["question"].(string)
		if strings.Contains(q, "a@b.co") || strings.Contains(q, "4111") {
			t.Fatal("question not redacted: " + q)
		}
		eq(t, len([]rune(d["answer"].(string))), 2000, "answer cut")
		sm := d["sqlMasked"].([]any)
		eq(t, len(sm), 5, "at most 5")
		if strings.Contains(sm[0].(string), "0912345678") {
			t.Fatal("literal not masked: " + sm[0].(string))
		}
	})

	t.Run("token lifecycle actions are accepted; unknown actions and non-objects are refused", func(t *testing.T) {
		for _, a := range []string{"agent.token.set", "agent.token.delete", "agent.openmetadata.token.set", "agent.openmetadata.token.delete"} {
			status(t, alice.Post("/agent/audit", map[string]any{"action": a, "endpointId": "e", "tools": []any{"search_metadata"}}), 201, a)
		}
		eq(t, alice.Post("/agent/audit", map[string]any{"action": "user.delete"}).Status, 400, "unknown action")
		eq(t, alice.Post("/agent/audit", map[string]any{}).Status, 400, "no action")
		eq(t, alice.Post("/agent/audit", []any{1}).Status, 400, "array")
	})

	t.Run("detail is bounded: long strings cut, deep nesting dropped", func(t *testing.T) {
		deep := map[string]any{"a": map[string]any{"b": map[string]any{"c": map[string]any{"d": 1}}}}
		status(t, alice.Post("/agent/audit", map[string]any{"action": "agent.chat", "note": strings.Repeat("x", 1000), "deep": deep}), 201, "bounded")
		d, _, _ := last("agent.chat")
		eq(t, len(d["note"].(string)), 200, "note cut")
		if _, ok := obj(obj(obj(d["deep"])["a"])["b"])["c"]; ok {
			t.Fatal("nesting beyond the limit was stored")
		}
	})
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
