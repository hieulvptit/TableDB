package auth

import (
	"context"
	"strings"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/db"
)

type Claims struct {
	Provider      string
	Sub           string
	Email         string
	EmailVerified bool
	Name          string
}

// UpsertUser finds or provisions the local user for an IdP identity and returns its id.
func UpsertUser(ctx context.Context, q db.Runner, cfg *config.Config, c Claims) (string, error) {
	return db.Tx(ctx, q, func(t db.Runner) (string, error) {
		var id string
		var active bool
		err := t.QueryRow(ctx, "SELECT id::text, active FROM users WHERE provider=$1 AND subject=$2", c.Provider, c.Sub).Scan(&id, &active)
		if err != nil && !db.IsNoRows(err) {
			return "", err
		}
		if db.IsNoRows(err) {
			var byEmail string
			err := t.QueryRow(ctx, "SELECT id::text FROM users WHERE lower(email)=lower($1)", c.Email).Scan(&byEmail)
			switch {
			case err == nil:
				// never link accounts across IdPs on an unverified email (account takeover)
				if !c.EmailVerified {
					return "", apperr.NewForbidden("email already registered under another identity provider and is not verified")
				}
				if _, err := t.Exec(ctx, "UPDATE users SET provider=$1, subject=$2, name=CASE WHEN name='' THEN $3 ELSE name END WHERE id=$4", c.Provider, c.Sub, c.Name, byEmail); err != nil {
					return "", err
				}
				if err := t.QueryRow(ctx, "SELECT id::text, active FROM users WHERE id=$1", byEmail).Scan(&id, &active); err != nil {
					return "", err
				}
			case db.IsNoRows(err):
				if err := t.QueryRow(ctx, "INSERT INTO users (provider, subject, email, name) VALUES ($1,$2,$3,$4) RETURNING id::text, active", c.Provider, c.Sub, c.Email, c.Name).Scan(&id, &active); err != nil {
					return "", err
				}
				if _, err := t.Exec(ctx, "INSERT INTO role_assignments (user_id, role) VALUES ($1,'user')", id); err != nil {
					return "", err
				}
				if err := audit.Write(ctx, t, audit.Entry{ActorID: id, ActorLabel: c.Email, Action: "user.provisioned", ResourceType: "user", ResourceID: id, Detail: map[string]any{"provider": c.Provider}}); err != nil {
					return "", err
				}
			default:
				return "", err
			}
		}
		if !active {
			return "", apperr.NewForbidden("account disabled")
		}
		lower := strings.ToLower(c.Email)
		for _, a := range cfg.BootstrapAdmins {
			if a == lower && c.EmailVerified {
				if _, err := t.Exec(ctx, "INSERT INTO role_assignments (user_id, role) VALUES ($1,'admin') ON CONFLICT DO NOTHING", id); err != nil {
					return "", err
				}
				break
			}
		}
		return id, nil
	})
}
