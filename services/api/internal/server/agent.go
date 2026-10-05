package server

import (
	"vnpay/tabledb-api/internal/agent"
	"vnpay/tabledb-api/internal/app"
)

// The Agent runs in the desktop app; the server only exposes the audit sink (POST /api/v1/agent/audit).
func init() {
	RegisterAgentRoutes = func(rt *app.Router, d *app.Deps) { agent.Register(rt, d) }
}
