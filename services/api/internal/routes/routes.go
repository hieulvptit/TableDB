package routes

import (
	"strings"

	"errors"
	"github.com/jackc/pgx/v5"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/config"
)

type configProvider = config.OidcProvider

// H groups the handlers' dependencies.
type H struct{ D *app.Deps }

// Register mounts the auth, db, transfer and audit routes (not the Agent: phase 2 hooks in through server.RegisterAgentRoutes).
func Register(rt *app.Router) {
	h := &H{D: rt.D}
	h.registerAuth(rt)
	h.registerDB(rt)
	h.registerTransfers(rt)
	h.registerAudit(rt)
}

func dbNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
func lower(s string) string   { return strings.ToLower(s) }
