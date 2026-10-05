// Package agent: the SQL Agent runs entirely in the desktop app (harness, LLM and OpenMetadata calls, tokens). The server keeps
// only an audit sink, like /db/audit: the desktop reports one record per Agent action: metadata plus the redacted question and
// answer text and the proposed SQL with literals masked. Never rows, images or tokens. The server cannot verify the content,
// so entries are marked reportedBy=desktop.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/shared"
)

// actions the desktop may report; anything else is a 400.
var actions = map[string]bool{
	"agent.chat":                      true,
	"agent.token.set":                 true,
	"agent.token.delete":              true,
	"agent.openmetadata.token.set":    true,
	"agent.openmetadata.token.delete": true,
}

// keys that would carry prompt/reply/credential text are never stored, whatever the client sends.
var forbiddenKey = regexp.MustCompile(`(?i)^(prompt|reply|content|text|sql|token|secret|password|authorization|message|messages|body)$`)

// Q&A kept for the audit trail: redacted again here (the desktop already redacts; the server does not trust it) and bounded.
const maxQA = 2000

const (
	maxDepth   = 3
	maxKeys    = 32
	maxItems   = 64
	maxStr     = 200
	maxEncoded = 8 << 10
)

func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// clean keeps booleans, numbers, bounded strings and nested arrays/objects of those; everything else is dropped.
func clean(v any, depth int) (any, bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i, true
		}
		if f, err := x.Float64(); err == nil {
			return f, true
		}
		return nil, false
	case string:
		return cut(x, maxStr), true
	case []any:
		if depth >= maxDepth {
			return nil, false
		}
		out := make([]any, 0, len(x))
		for _, e := range x {
			if len(out) >= maxItems {
				break
			}
			if c, ok := clean(e, depth+1); ok {
				out = append(out, c)
			}
		}
		return out, true
	case map[string]any:
		if depth >= maxDepth {
			return nil, false
		}
		out := map[string]any{}
		for k, e := range x {
			if len(out) >= maxKeys {
				break
			}
			if forbiddenKey.MatchString(k) || len(k) > 64 {
				continue
			}
			if c, ok := clean(e, depth+1); ok {
				out[k] = c
			}
		}
		return out, true
	}
	return nil, false
}

// Register mounts POST /api/v1/agent/audit.
func Register(rt *app.Router, d *app.Deps) {
	rate := &app.Rate{Max: 120, Window: time.Minute}
	rt.POST("/agent/audit", app.Opts{Rate: rate}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.Need(r, "agent:use")
		if err != nil {
			return err
		}
		body, err := app.ReadBody(w, r, maxEncoded)
		if err != nil {
			return err
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		var raw map[string]any
		if err := dec.Decode(&raw); err != nil || raw == nil {
			return apperr.Validation("body must be a JSON object")
		}
		action, _ := raw["action"].(string)
		if !actions[action] {
			return apperr.Validation("unknown agent action")
		}
		detail := map[string]any{}
		resourceID := ""
		for k, v := range raw {
			switch {
			case k == "action":
			case k == "connectionId":
				if s, ok := v.(string); ok {
					resourceID = cut(s, 128)
				}
			case k == "question" || k == "answer":
				if s, ok := v.(string); ok && s != "" {
					detail[k] = shared.RedactText(cut(s, maxQA))
				}
			case k == "sqlMasked": // SQL the Agent proposed: literals masked here, whatever the client sent
				if arr, ok := v.([]any); ok {
					out := []any{}
					for _, e := range arr {
						if s, ok := e.(string); ok && len(out) < 5 {
							out = append(out, cut(shared.MaskSQL(s), 1000))
						}
					}
					detail[k] = out
				}
			default:
				if forbiddenKey.MatchString(k) || len(k) > 64 || len(detail) >= maxKeys {
					continue
				}
				if c, ok := clean(v, 1); ok {
					detail[k] = c
				}
			}
		}
		detail["reportedBy"] = "desktop"
		e := audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: action, IP: d.ClientIP(r), Detail: detail}
		if resourceID != "" {
			e.ResourceType, e.ResourceID = "connection", resourceID
		}
		if err := audit.Write(context.WithoutCancel(r.Context()), d.DB, e); err != nil {
			return err
		}
		app.WriteJSON(w, 201, map[string]any{"ok": true})
		return nil
	})
}
