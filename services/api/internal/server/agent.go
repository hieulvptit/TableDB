package server

import (
	"vnpay/tabledb-api/internal/agent"
	"vnpay/tabledb-api/internal/app"
)

// The Agent runs in the desktop app; the server exposes deployment config (GET /api/v1/agent/config) and the audit sink.
func init() {
	RegisterAgentRoutes = func(rt *app.Router, d *app.Deps) { agent.Register(rt, d) }
}
