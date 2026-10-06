// Package routes holds the HTTP handlers of the /api/v1 surface (everything except the Agent, which is phase 2).
package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/auth"
	"vnpay/tabledb-api/internal/crypto"
	"vnpay/tabledb-api/internal/shared"
)

// SafeReturnTo allows only same-origin absolute paths.
func SafeReturnTo(s string) string {
	if len(s) > 0 && s[0] == '/' && !(len(s) > 1 && s[1] == '/') && !containsAny(s, "\\\r\n") {
		return s
	}
	return "/"
}

func containsAny(s, chars string) bool {
	for _, c := range chars {
		for _, x := range s {
			if x == c {
				return true
			}
		}
	}
	return false
}

func (h *H) setCookie(w http.ResponseWriter, id string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{Name: h.D.CookieName(), Value: id, HttpOnly: true, Secure: h.D.Cfg.IsHTTPS(),
		SameSite: http.SameSiteLaxMode, Path: "/", Expires: expires})
}

func redirect(w http.ResponseWriter, to string) {
	w.Header().Set("Location", to)
	w.WriteHeader(http.StatusFound)
}

// query validation helper: zod z.string() for a required query param.
func requiredQuery(r *http.Request, k string) (string, error) {
	if !r.URL.Query().Has(k) {
		return "", &shared.ValidationError{Issues: []shared.Issue{{Path: k, Message: "Required"}}}
	}
	return r.URL.Query().Get(k), nil
}

type userBrief struct {
	ID    string   `json:"id"`
	Email string   `json:"email"`
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
}

type desktopTokens struct {
	AccessToken  string     `json:"accessToken"`
	ExpiresAt    string     `json:"expiresAt"`
	RefreshToken string     `json:"refreshToken"`
	User         *userBrief `json:"user,omitempty"`
}

func roleStrings(p *shared.Principal) []string {
	out := make([]string, 0, len(p.Roles))
	for _, r := range p.Roles {
		out = append(out, string(r))
	}
	return out
}

var loopbackRe = regexp.MustCompile(`^http://127\.0\.0\.1:\d{2,5}/cb$`)
var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// auditLoginFailure records only trusted identity and bounded error codes, never
// callback parameters, broker tokens, or upstream error text.
func (h *H) auditLoginFailure(r *http.Request, entry audit.Entry, result *error) {
	if *result == nil {
		return
	}
	reason := apperr.Internal
	var ae *apperr.Error
	var ve *shared.ValidationError
	if errors.As(*result, &ae) {
		reason = ae.Code
	} else if errors.As(*result, &ve) {
		reason = apperr.ValidationCode
	}
	entry.Action = "auth.login_failed"
	entry.IP = h.D.ClientIP(r)
	entry.Detail["reason"] = string(reason)
	if err := audit.Write(r.Context(), h.D.DB, entry); err != nil {
		*result = err
	}
}

func (h *H) registerAuth(rt *app.Router) {
	d := h.D
	loginRate := &app.Rate{Max: 30, Window: time.Minute}
	P := app.Opts{Public: true, Rate: loginRate}

	rt.GET("/auth/config", app.Opts{Public: true}, func(w http.ResponseWriter, r *http.Request) error {
		type prov struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		}
		provs := []prov{}
		for _, p := range d.Cfg.OidcProviders {
			provs = append(provs, prov{p.ID, p.Label})
		}
		var desktop *string
		g := d.Cfg.Genai
		if g.LoginURL != "" && (g.VerifyURL != "" || g.JWTKey != "" || g.DevTrustUnverified) {
			desktop = &g.LoginURL
		}
		app.WriteJSON(w, 200, map[string]any{"providers": provs, "devLogin": d.Cfg.AllowDevLogin && d.Cfg.Env != "prod", "desktopLoginUrl": desktop})
		return nil
	})

	provider := func(id string) (*configProvider, error) {
		p := d.Cfg.Provider(id)
		if p == nil {
			return nil, apperr.Validation("unknown provider")
		}
		return p, nil
	}

	rt.GET("/auth/login", P, func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		pid, err := requiredQuery(r, "provider")
		if err != nil {
			return err
		}
		p, err := provider(pid)
		if err != nil {
			return err
		}
		state, verifier, nonce := crypto.RandomToken(24), auth.NewVerifier(), crypto.RandomToken(16)
		ctx := r.Context()
		if _, err := d.DB.Exec(ctx, "DELETE FROM auth_states WHERE created_at < now() - interval '15 minutes'"); err != nil {
			return err
		}
		stepup := q.Get("stepup") == "1"
		if _, err := d.DB.Exec(ctx, "INSERT INTO auth_states (state_hash, provider, code_verifier, nonce, return_to, stepup) VALUES ($1,$2,$3,$4,$5,$6)",
			crypto.Sha256HexString(state), p.ID, verifier, nonce, SafeReturnTo(q.Get("returnTo")), stepup); err != nil {
			return err
		}
		u, err := d.OIDC.AuthorizeURL(ctx, p, auth.AuthorizeOpts{RedirectURI: d.Cfg.PublicURL + "/api/v1/auth/callback", State: state,
			Challenge: auth.PKCEChallenge(verifier), Nonce: nonce, Stepup: stepup})
		if err != nil {
			return err
		}
		redirect(w, u)
		return nil
	})

	rt.GET("/auth/callback", P, func(w http.ResponseWriter, r *http.Request) (result error) {
		failure := audit.Entry{ActorLabel: "anonymous", Detail: map[string]any{"via": "oidc", "kind": "web"}}
		defer func() { h.auditLoginFailure(r, failure, &result) }()
		q := r.URL.Query()
		state, err := requiredQuery(r, "state")
		if err != nil {
			return err
		}
		code, errParam := q.Get("code"), q.Get("error")
		ctx := r.Context()
		// single use: DELETE … RETURNING
		var stProvider, stVerifier, stNonce, stReturn string
		var stStepup bool
		err = d.DB.QueryRow(ctx, "DELETE FROM auth_states WHERE state_hash=$1 AND created_at > now() - interval '10 minutes' RETURNING provider, code_verifier, nonce, return_to, stepup",
			crypto.Sha256HexString(state)).Scan(&stProvider, &stVerifier, &stNonce, &stReturn, &stStepup)
		if err != nil {
			if dbNoRows(err) {
				return apperr.Unauth("invalid or expired login state")
			}
			return err
		}
		if errParam != "" || code == "" {
			return apperr.Unauth("login was not completed")
		}
		p, err := provider(stProvider)
		if err != nil {
			return err
		}
		failure.Detail["provider"] = p.ID
		redirectURI := d.Cfg.PublicURL + "/api/v1/auth/callback"
		idToken, err := d.OIDC.Exchange(ctx, p, auth.ExchangeOpts{Code: code, Verifier: stVerifier, RedirectURI: redirectURI})
		if err != nil {
			return err
		}
		claims, err := d.OIDC.VerifyIDToken(ctx, p, idToken, auth.VerifyOpts{Nonce: &stNonce, Audience: p.ClientID})
		if err != nil {
			return err
		}
		nowSec := d.Now().Unix()
		if stStepup && nowSec-claims.AuthTime > 120 {
			return apperr.Unauth("identity provider did not re-authenticate the user")
		}
		if claims.EmailVerified {
			failure.ActorLabel = claims.Email
		}
		userID, err := auth.UpsertUser(ctx, d.DB, d.Cfg, auth.Claims{Provider: p.ID, Sub: claims.Sub, Email: claims.Email, EmailVerified: claims.EmailVerified, Name: claims.Name})
		if err != nil {
			return err
		}
		failure.ActorID = userID
		authTime := d.Now()
		if claims.AuthTime != 0 {
			authTime = time.Unix(claims.AuthTime, 0)
		}
		var rawCookie string
		if c, err := r.Cookie(d.CookieName()); err == nil {
			rawCookie = c.Value
		}
		var existing *auth.Loaded
		if stStepup && rawCookie != "" {
			existing, err = auth.LoadSession(ctx, d.DB, rawCookie)
			if err != nil {
				return err
			}
		}
		ip := d.ClientIP(r)
		if existing != nil && existing.Principal.ID == userID {
			if _, err := d.DB.Exec(ctx, "UPDATE sessions SET auth_time=$1 WHERE id_hash=$2", authTime, crypto.Sha256HexString(rawCookie)); err != nil {
				return err
			}
			if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: userID, ActorLabel: claims.Email, Action: "auth.stepup", IP: ip}); err != nil {
				return err
			}
		} else {
			if existing != nil {
				if err := auth.DestroySession(ctx, d.DB, rawCookie); err != nil {
					return err
				}
			}
			s, err := auth.CreateSession(ctx, d.DB, auth.NewSession{UserID: userID, Kind: shared.ClientWeb, AuthTime: authTime, TTLHours: d.Cfg.SessionTTLHours})
			if err != nil {
				return err
			}
			h.setCookie(w, s.ID, s.ExpiresAt)
			if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: userID, ActorLabel: claims.Email, Action: "auth.login", IP: ip, Detail: map[string]any{"provider": p.ID, "kind": "web"}}); err != nil {
				return err
			}
		}
		redirect(w, stReturn)
		return nil
	})

	rt.POST("/auth/logout", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		ctx := r.Context()
		if a.RawSessionID != "" {
			if err := auth.DestroySession(ctx, d.DB, a.RawSessionID); err != nil {
				return err
			}
		}
		http.SetCookie(w, &http.Cookie{Name: d.CookieName(), Value: "", Path: "/", HttpOnly: true, Secure: d.Cfg.IsHTTPS(),
			SameSite: http.SameSiteLaxMode, Expires: time.Unix(0, 0), MaxAge: -1})
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: a.Principal.ID, ActorLabel: a.Email, Action: "auth.logout", IP: d.ClientIP(r)}); err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ok": true})
		return nil
	})

	rt.GET("/auth/me", app.Opts{}, func(w http.ResponseWriter, r *http.Request) error {
		a, err := app.AuthOf(r)
		if err != nil {
			return err
		}
		perms := []string{}
		for _, p := range shared.PermissionsOf(a.Principal) {
			perms = append(perms, string(p))
		}
		app.WriteJSON(w, 200, map[string]any{
			"user":      map[string]any{"id": a.Principal.ID, "email": a.Email, "name": a.Name, "roles": roleStrings(&a.Principal), "permissions": perms},
			"csrfToken": a.CSRF, "authTime": app.ISO(a.AuthTime), "kind": a.Kind,
		})
		return nil
	})

	// ---- desktop (RFC 8252 loopback; the native app opens the system browser itself)
	rt.GET("/auth/desktop/config", P, func(w http.ResponseWriter, r *http.Request) error {
		p, err := provider(r.URL.Query().Get("provider"))
		if err != nil {
			return err
		}
		if p.DesktopClientID == "" {
			return apperr.Validation("desktop login not configured for provider")
		}
		disc, err := d.OIDC.Discovery(r.Context(), p)
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"authorizeEndpoint": disc.AuthorizationEndpoint, "clientId": p.DesktopClientID, "scopes": p.Scopes,
			"redirectUriTemplate": "http://127.0.0.1:{port}/cb"})
		return nil
	})

	rt.POST("/auth/desktop/exchange", P, func(w http.ResponseWriter, r *http.Request) (result error) {
		failure := audit.Entry{ActorLabel: "anonymous", Detail: map[string]any{"via": "oidc", "kind": "desktop"}}
		defer func() { h.auditLoginFailure(r, failure, &result) }()
		body, err := app.ReadBody(w, r, app.JSONBodyLimit)
		if err != nil {
			return err
		}
		o := shared.DecodeObject(body)
		pid, _ := o.String("provider", true, 0, 0)
		code, _ := o.String("code", true, 1, 0)
		verifier, _ := o.String("codeVerifier", true, 43, 128)
		redirectURI, _ := o.String("redirectUri", true, 0, 0)
		if err := o.Err(); err != nil {
			return err
		}
		if !loopbackRe.MatchString(redirectURI) {
			return apperr.Validation("redirectUri must be a loopback address")
		}
		p, err := provider(pid)
		if err != nil {
			return err
		}
		failure.Detail["provider"] = p.ID
		ctx := r.Context()
		idToken, err := d.OIDC.Exchange(ctx, p, auth.ExchangeOpts{Code: code, Verifier: verifier, RedirectURI: redirectURI, Desktop: true})
		if err != nil {
			return err
		}
		claims, err := d.OIDC.VerifyIDToken(ctx, p, idToken, auth.VerifyOpts{Audience: p.DesktopClientID})
		if err != nil {
			return err
		}
		if claims.EmailVerified {
			failure.ActorLabel = claims.Email
		}
		userID, err := auth.UpsertUser(ctx, d.DB, d.Cfg, auth.Claims{Provider: p.ID, Sub: claims.Sub, Email: claims.Email, EmailVerified: claims.EmailVerified, Name: claims.Name})
		if err != nil {
			return err
		}
		failure.ActorID = userID
		authTime := d.Now()
		if claims.AuthTime != 0 {
			authTime = time.Unix(claims.AuthTime, 0)
		}
		s, err := auth.CreateSession(ctx, d.DB, auth.NewSession{UserID: userID, Kind: shared.ClientDesktop, AuthTime: authTime, WithRefresh: true})
		if err != nil {
			return err
		}
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: userID, ActorLabel: claims.Email, Action: "auth.login", IP: d.ClientIP(r), Detail: map[string]any{"provider": p.ID, "kind": "desktop"}}); err != nil {
			return err
		}
		pr, err := auth.LoadPrincipal(ctx, d.DB, userID)
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, desktopTokens{AccessToken: s.ID, ExpiresAt: app.ISO(s.ExpiresAt), RefreshToken: s.Refresh,
			User: &userBrief{ID: userID, Email: claims.Email, Name: claims.Name, Roles: roleStrings(pr)}})
		return nil
	})

	// Desktop login through the VNPAY SSO broker: the app obtained a broker JWT on its loopback listener; we ask who it is.
	genaiRate := &app.Rate{Max: d.Cfg.LoginRateLimitPerMin, Window: time.Minute}
	rt.POST("/auth/desktop/genai", app.Opts{Public: true, Rate: genaiRate}, func(w http.ResponseWriter, r *http.Request) (result error) {
		failure := audit.Entry{ActorLabel: "anonymous", Detail: map[string]any{"via": "genai", "kind": "desktop"}}
		defer func() { h.auditLoginFailure(r, failure, &result) }()
		body, err := app.ReadBody(w, r, app.JSONBodyLimit)
		if err != nil {
			return err
		}
		o := shared.DecodeObject(body)
		token, _ := o.String("token", true, 10, 6200)
		if err := o.Err(); err != nil {
			return err
		}
		ctx := r.Context()
		id, err := d.Genai.Verify(ctx, token)
		if err != nil {
			return err
		}
		failure.ActorLabel = id.Email
		userID, err := auth.UpsertUser(ctx, d.DB, d.Cfg, auth.Claims{Provider: "genai", Sub: id.Email, Email: id.Email, EmailVerified: true, Name: id.Name})
		if err != nil {
			return err
		}
		failure.ActorID = userID
		s, err := auth.CreateSession(ctx, d.DB, auth.NewSession{UserID: userID, Kind: shared.ClientDesktop, AuthTime: d.Now(), WithRefresh: true})
		if err != nil {
			return err
		}
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: userID, ActorLabel: id.Email, Action: "auth.login", IP: d.ClientIP(r), Detail: map[string]any{"via": "genai", "kind": "desktop"}}); err != nil {
			return err
		}
		pr, err := auth.LoadPrincipal(ctx, d.DB, userID)
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, desktopTokens{AccessToken: s.ID, ExpiresAt: app.ISO(s.ExpiresAt), RefreshToken: s.Refresh,
			User: &userBrief{ID: userID, Email: id.Email, Name: id.Name, Roles: roleStrings(pr)}})
		return nil
	})

	rt.POST("/auth/desktop/refresh", P, func(w http.ResponseWriter, r *http.Request) error {
		body, err := app.ReadBody(w, r, app.JSONBodyLimit)
		if err != nil {
			return err
		}
		o := shared.DecodeObject(body)
		rtok, _ := o.String("refreshToken", true, 10, 0)
		if err := o.Err(); err != nil {
			return err
		}
		ctx := r.Context()
		// rotation, atomically: the old session (and its refresh token) dies the moment it is used
		var userID string
		var authTime time.Time
		err = d.DB.QueryRow(ctx,
			`DELETE FROM sessions s USING users u WHERE u.id=s.user_id AND s.refresh_hash=$1 AND s.refresh_expires_at > now() AND u.active
			 RETURNING s.user_id::text, s.auth_time`, crypto.Sha256HexString(rtok)).Scan(&userID, &authTime)
		if err != nil {
			if dbNoRows(err) {
				return apperr.Unauth("invalid refresh token")
			}
			return err
		}
		s, err := auth.CreateSession(ctx, d.DB, auth.NewSession{UserID: userID, Kind: shared.ClientDesktop, AuthTime: authTime, WithRefresh: true})
		if err != nil {
			return err
		}
		app.WriteJSON(w, 200, desktopTokens{AccessToken: s.ID, ExpiresAt: app.ISO(s.ExpiresAt), RefreshToken: s.Refresh})
		return nil
	})

	// Local development only (double-guarded; refused in prod by config validation and here).
	rt.POST("/auth/dev-login", P, func(w http.ResponseWriter, r *http.Request) error {
		if !d.Cfg.AllowDevLogin || d.Cfg.Env == "prod" {
			return apperr.NotFound("not found")
		}
		body, err := app.ReadBody(w, r, app.JSONBodyLimit)
		if err != nil {
			return err
		}
		o := shared.DecodeObject(body)
		email, ok := o.String("email", true, 0, 0)
		if ok && !emailRe.MatchString(email) {
			o.Issues = append(o.Issues, shared.Issue{Path: "email", Message: "Invalid email"})
		}
		name, hasName := o.String("name", false, 0, 0)
		if err := o.Err(); err != nil {
			return err
		}
		if !hasName {
			name = email
		}
		ctx := r.Context()
		userID, err := auth.UpsertUser(ctx, d.DB, d.Cfg, auth.Claims{Provider: "dev", Sub: email, Email: lower(email), EmailVerified: true, Name: name})
		if err != nil {
			return err
		}
		s, err := auth.CreateSession(ctx, d.DB, auth.NewSession{UserID: userID, Kind: shared.ClientWeb, AuthTime: d.Now(), TTLHours: d.Cfg.SessionTTLHours})
		if err != nil {
			return err
		}
		h.setCookie(w, s.ID, s.ExpiresAt)
		if err := audit.Write(ctx, d.DB, audit.Entry{ActorID: userID, ActorLabel: lower(email), Action: "auth.login", IP: d.ClientIP(r), Detail: map[string]any{"via": "dev", "kind": "web"}}); err != nil {
			return err
		}
		app.WriteJSON(w, 200, map[string]any{"ok": true, "csrfToken": s.CSRF})
		return nil
	})
	_ = json.Marshal
}
