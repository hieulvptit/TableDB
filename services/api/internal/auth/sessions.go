// Package auth: sessions, OIDC, broker (genai) login, user provisioning.
package auth

import (
	"context"
	"time"

	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/shared"
)

// Ctx is the authenticated caller attached to a request.
type Ctx struct {
	Principal      shared.Principal
	Email          string
	Name           string
	Kind           shared.ClientKind
	CSRF           string
	AuthTime       time.Time
	SessionExpires time.Time
	RawSessionID   string
}

type SessionRow struct {
	UserID    string
	Kind      shared.ClientKind
	CSRF      string
	AuthTime  time.Time
	ExpiresAt time.Time
}

type NewSession struct {
	UserID      string
	Kind        shared.ClientKind
	AuthTime    time.Time
	TTLHours    float64
	WithRefresh bool
}

type Created struct {
	ID        string
	CSRF      string
	ExpiresAt time.Time
	Refresh   string // "" when none
}

// CreateSession stores only SHA-256 hashes of the session id and refresh token.
// Desktop sessions live 15 minutes (refreshable for 7 days); web sessions SESSION_TTL_HOURS.
func CreateSession(ctx context.Context, q db.Querier, o NewSession) (Created, error) {
	id := crypto.RandomToken(32)
	csrf := crypto.RandomToken(24)
	now := time.Now()
	var exp time.Time
	if o.Kind == shared.ClientDesktop {
		exp = now.Add(15 * time.Minute)
	} else {
		exp = now.Add(time.Duration(o.TTLHours * float64(time.Hour)))
	}
	c := Created{ID: id, CSRF: csrf, ExpiresAt: exp}
	var refreshHash *string
	var refreshExp *time.Time
	if o.WithRefresh {
		c.Refresh = crypto.RandomToken(32)
		h := crypto.Sha256HexString(c.Refresh)
		refreshHash = &h
		e := now.Add(7 * 24 * time.Hour)
		refreshExp = &e
	}
	_, err := q.Exec(ctx,
		`INSERT INTO sessions (id_hash, user_id, kind, csrf, auth_time, expires_at, refresh_hash, refresh_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		crypto.Sha256HexString(id), o.UserID, string(o.Kind), csrf, o.AuthTime, exp, refreshHash, refreshExp)
	return c, err
}

type Loaded struct {
	Session   SessionRow
	Principal shared.Principal
	Email     string
	Name      string
}

// LoadSession returns nil when the session is unknown/expired or the user is inactive.
func LoadSession(ctx context.Context, q db.Querier, rawID string) (*Loaded, error) {
	var s SessionRow
	var kind, email, name string
	var active bool
	err := q.QueryRow(ctx,
		`SELECT s.user_id::text, s.kind, s.csrf, s.auth_time, s.expires_at, u.active, u.email, u.name
		 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1 AND s.expires_at > now()`,
		crypto.Sha256HexString(rawID)).Scan(&s.UserID, &kind, &s.CSRF, &s.AuthTime, &s.ExpiresAt, &active, &email, &name)
	if err != nil {
		if db.IsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	if !active {
		return nil, nil
	}
	s.Kind = shared.ClientKind(kind)
	p, err := LoadPrincipal(ctx, q, s.UserID)
	if err != nil || p == nil {
		return nil, err
	}
	return &Loaded{Session: s, Principal: *p, Email: email, Name: name}, nil
}

// LoadPrincipal loads roles/grants fresh on every call (so role changes apply immediately).
func LoadPrincipal(ctx context.Context, q db.Querier, userID string) (*shared.Principal, error) {
	p := shared.Principal{}
	err := q.QueryRow(ctx, "SELECT id::text, active FROM users WHERE id=$1", userID).Scan(&p.ID, &p.Active)
	if err != nil {
		if db.IsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	rows, err := q.Query(ctx, "SELECT role FROM role_assignments WHERE user_id=$1", userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			rows.Close()
			return nil, err
		}
		p.Roles = append(p.Roles, shared.Role(r))
	}
	rows.Close()
	g, err := q.Query(ctx, "SELECT permission FROM user_grants WHERE user_id=$1", userID)
	if err != nil {
		return nil, err
	}
	for g.Next() {
		var r string
		if err := g.Scan(&r); err != nil {
			g.Close()
			return nil, err
		}
		p.Grants = append(p.Grants, shared.Permission(r))
	}
	g.Close()
	if len(p.Roles) == 0 {
		p.Roles = []shared.Role{shared.RoleUser}
	}
	return &p, nil
}

func DestroySession(ctx context.Context, q db.Querier, rawID string) error {
	_, err := q.Exec(ctx, "DELETE FROM sessions WHERE id_hash=$1", crypto.Sha256HexString(rawID))
	return err
}
