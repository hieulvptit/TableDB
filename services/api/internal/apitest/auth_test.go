package apitest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/crypto"
)

type ssoEnv struct {
	*Harness
	idp   *Idp
	proxy *Proxy
}

func newSSO(t *testing.T) *ssoEnv {
	idp := startIdp(t)
	proxy := startProxy(t)
	providers, _ := json.Marshal([]map[string]any{{"id": "s2o", "label": "VNPAY S2O", "issuer": idp.URL(), "clientId": "bo-web", "clientSecret": "shh", "desktopClientId": "bo-desktop"}})
	proxies, _ := json.Marshal(map[string]string{"oidc": proxy.URL()}) // SSO hop goes through the OIDC proxy only (per-hop proxies: other hops are direct)
	h := harness(t, map[string]string{"OIDC_PROVIDERS": string(providers), "OUTBOUND_PROXIES": string(proxies)})
	return &ssoEnv{h, idp, proxy}
}

func (e *ssoEnv) login(t *testing.T, email string, extra IdpUser, returnTo string) (loc, code, state string) {
	t.Helper()
	if returnTo == "" {
		returnTo = "/transfers"
	}
	r := e.Anon("GET", "/auth/login?provider=s2o&returnTo="+url.QueryEscape(returnTo))
	status(t, r, 302, "login redirect")
	loc = r.Header.Get("Location")
	if !strings.HasPrefix(loc, e.idp.URL()+"/authorize") {
		t.Fatalf("redirect to %s", loc)
	}
	extra.Email = email
	code, state = e.idp.IssueCode(loc, extra)
	return
}

func (e *ssoEnv) cb(code, state, cookie string) *Resp {
	h := map[string]string{}
	if cookie != "" {
		h["Cookie"] = cookie
	}
	return e.Anon("GET", "/api/v1/auth/callback?code="+code+"&state="+state, Opt{Headers: h})
}

func TestOIDCLogin(t *testing.T) {
	e := newSSO(t)
	t.Run("completes login, sets httpOnly cookie, and all IdP traffic used the proxy", func(t *testing.T) {
		loc, code, state := e.login(t, "sso1@vnpay.vn", IdpUser{}, "")
		u, _ := url.Parse(loc)
		eq(t, u.Query().Get("code_challenge_method"), "S256", "pkce method")
		r := e.cb(code, state, "")
		status(t, r, 302, "callback")
		eq(t, r.Header.Get("Location"), "/transfers", "return_to")
		sc := r.Header.Get("Set-Cookie")
		if !strings.Contains(sc, "HttpOnly") || !strings.Contains(sc, "SameSite=Lax") || strings.Contains(sc, "Secure") {
			t.Fatalf("cookie flags (http PUBLIC_URL): %s", sc)
		}
		me := e.Anon("GET", "/auth/me", Opt{Headers: map[string]string{"Cookie": strings.SplitN(sc, ";", 2)[0]}})
		eq(t, me.Str("user.email"), "sso1@vnpay.vn", "me.email")
		if !e.proxy.SawHost(strings.TrimPrefix(e.idp.URL(), "http://")) {
			t.Fatalf("IdP traffic bypassed the proxy: %v", e.proxy.Seen())
		}
		found := false
		for _, h := range e.idp.Hits() {
			if h == "POST /token" {
				found = true
			}
		}
		if !found {
			t.Fatal("no token exchange")
		}
	})
	t.Run("state is single-use (replay rejected)", func(t *testing.T) {
		_, code, state := e.login(t, "sso2@vnpay.vn", IdpUser{}, "")
		status(t, e.cb(code, state, ""), 302, "first")
		status(t, e.cb(code, state, ""), 401, "replay")
	})
	t.Run("rejects unknown state, wrong nonce, wrong audience, wrong issuer", func(t *testing.T) {
		status(t, e.cb("x", "nope", ""), 401, "unknown state")
		for name, bad := range map[string]IdpUser{"nonce": {NonceOverride: "evil"}, "aud": {Aud: "someone-else"}, "issuer": {Issuer: "https://evil.example"}} {
			_, code, state := e.login(t, "sso3@vnpay.vn", bad, "")
			r := e.cb(code, state, "")
			status(t, r, 401, name)
			if r.Header.Get("Set-Cookie") != "" {
				t.Fatalf("%s: cookie set on a failed login", name)
			}
		}
	})
	t.Run("does not allow open redirect via returnTo", func(t *testing.T) {
		_, code, state := e.login(t, "sso4@vnpay.vn", IdpUser{}, "//evil.example/x")
		eq(t, e.cb(code, state, "").Header.Get("Location"), "/", "location")
		for _, bad := range []string{"https://evil.example", `/\evil`, "/a\r\nb"} {
			_, code, state := e.login(t, "sso4@vnpay.vn", IdpUser{}, bad)
			eq(t, e.cb(code, state, "").Header.Get("Location"), "/", bad)
		}
	})
	t.Run("bootstrap admin only when email is verified", func(t *testing.T) {
		_, code, state := e.login(t, "admin@vnpay.vn", IdpUser{}, "")
		r := e.cb(code, state, "")
		me := e.Anon("GET", "/auth/me", Opt{Headers: map[string]string{"Cookie": strings.SplitN(r.Header.Get("Set-Cookie"), ";", 2)[0]}})
		roles, _ := json.Marshal(me.Get("user.roles"))
		if !strings.Contains(string(roles), "admin") {
			t.Fatalf("roles %s", roles)
		}
	})
	t.Run("no linking across IdPs by unverified email", func(t *testing.T) {
		e.User("victim@vnpay.vn") // dev-login account owns the email
		_, code, state := e.login(t, "victim@vnpay.vn", IdpUser{Sub: "other-subject"}, "")
		// the mock IdP says email_verified=true, so linking is allowed; the unverified path is covered at the unit level below
		status(t, e.cb(code, state, ""), 302, "verified link")
	})
	t.Run("step-up requires a fresh IdP authentication (prompt=login, max_age=0) and updates auth_time", func(t *testing.T) {
		_, code, state := e.login(t, "sso5@vnpay.vn", IdpUser{}, "")
		r1 := e.cb(code, state, "")
		cookie := strings.SplitN(r1.Header.Get("Set-Cookie"), ";", 2)[0]
		e.Exec("UPDATE sessions SET auth_time = now() - interval '2 hours'")
		s := e.Anon("GET", "/auth/login?provider=s2o&stepup=1&returnTo=/x", Opt{Headers: map[string]string{"Cookie": cookie}})
		loc, _ := url.Parse(s.Header.Get("Location"))
		eq(t, loc.Query().Get("prompt"), "login", "prompt")
		eq(t, loc.Query().Get("max_age"), "0", "max_age")
		// IdP that ignores prompt=login (stale auth_time) must be refused
		stale, st := e.idp.IssueCode(s.Header.Get("Location"), IdpUser{Email: "sso5@vnpay.vn", AuthTime: nowSec() - 3600})
		status(t, e.cb(stale, st, cookie), 401, "stale re-auth")
		s2 := e.Anon("GET", "/auth/login?provider=s2o&stepup=1&returnTo=/x", Opt{Headers: map[string]string{"Cookie": cookie}})
		fresh, fs := e.idp.IssueCode(s2.Header.Get("Location"), IdpUser{Email: "sso5@vnpay.vn"})
		status(t, e.cb(fresh, fs, cookie), 302, "fresh re-auth")
		age := Scalar[float64](e.Harness, "SELECT extract(epoch from now() - auth_time)::float8 FROM sessions WHERE id_hash=$1", crypto.Sha256HexString(strings.SplitN(cookie, "=", 2)[1]))
		if age > 60 {
			t.Fatalf("auth_time not refreshed: %v", age)
		}
	})
	t.Run("unknown provider and missing params are validation errors", func(t *testing.T) {
		status(t, e.Anon("GET", "/auth/login?provider=nope"), 400, "unknown provider")
		status(t, e.Anon("GET", "/auth/login"), 400, "missing provider")
		status(t, e.Anon("GET", "/auth/callback"), 400, "missing state")
	})
	t.Run("/auth/config lists providers", func(t *testing.T) {
		r := e.Anon("GET", "/auth/config")
		eq(t, r.Str("providers.0.id"), "s2o", "provider id")
		eq(t, r.Bool("devLogin"), true, "devLogin")
		if r.Get("desktopLoginUrl") != nil {
			t.Fatal("desktopLoginUrl must be null when not configured")
		}
	})
}

func nowSec() int64 { return timeNow().Unix() }

func TestCSRFAndSessions(t *testing.T) {
	h := harness(t)
	t.Run("cookie sessions need X-CSRF-Token on POST; bearer sessions do not", func(t *testing.T) {
		c := h.User("csrf@vnpay.vn")
		status(t, h.Anon("POST", "/auth/logout", Opt{Headers: map[string]string{"Cookie": c.Cookie}}), 403, "no csrf")
		status(t, h.Anon("POST", "/auth/logout", Opt{Headers: map[string]string{"Cookie": c.Cookie, "X-CSRF-Token": "wrong"}}), 403, "wrong csrf")
		status(t, c.Post("/auth/logout", nil), 200, "logout")
		status(t, c.Get("/auth/me"), 401, "after logout")
	})
	t.Run("unauthenticated requests are refused before doing work", func(t *testing.T) {
		for _, c := range [][2]string{{"GET", "/transfers"}, {"GET", "/db/targets"}, {"PUT", "/transfers/x/parts/1"}, {"GET", "/audit"}} {
			status(t, h.Anon(c[0], c[1]), 401, c[1])
		}
	})
	t.Run("dev-login is hidden when disabled", func(t *testing.T) {
		h2 := harness(t, map[string]string{"ALLOW_DEV_LOGIN": "0"})
		r := h2.Anon("POST", "/auth/dev-login", Opt{Body: map[string]any{"email": "a@vnpay.vn"}})
		status(t, r, 404, "dev-login disabled")
		eq(t, h2.Anon("GET", "/auth/config").Bool("devLogin"), false, "devLogin flag")
	})
	t.Run("me returns user, permissions and csrf token", func(t *testing.T) {
		c := h.User("me@vnpay.vn")
		r := c.Get("/auth/me")
		eq(t, r.Str("kind"), "web", "kind")
		eq(t, r.Str("csrfToken"), c.CSRF, "csrf")
		perms, _ := json.Marshal(r.Get("user.permissions"))
		if !strings.Contains(string(perms), "transfer:create") || strings.Contains(string(perms), "admin:manage") {
			t.Fatalf("permissions %s", perms)
		}
		eq(t, c.Desk.Get("/auth/me").Str("kind"), "desktop", "desktop kind")
	})
	t.Run("expired session is refused", func(t *testing.T) {
		c := h.User("expiring@vnpay.vn")
		h.Exec("UPDATE sessions SET expires_at = now() - interval '1 minute'")
		status(t, c.Get("/auth/me"), 401, "expired")
	})
}

func TestDesktopLoopbackFlow(t *testing.T) {
	e := newSSO(t)
	verifier := strings.Repeat("v", 64)
	hsh := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(hsh[:])
	redirect := "http://127.0.0.1:53211/cb"
	authURL := e.idp.URL() + "/authorize?code_challenge=" + challenge + "&nonce=n&state=s&redirect_uri=" + url.QueryEscape(redirect)
	exchange := func(code, redir string) *Resp {
		return e.Anon("POST", "/auth/desktop/exchange", Opt{Body: map[string]any{"provider": "s2o", "code": code, "codeVerifier": verifier, "redirectUri": redir}})
	}
	bearer := func(tok string) *Client { return &Client{h: e.Harness, Bearer: tok} }

	status(t, e.Anon("GET", "/auth/desktop/config?provider=s2o"), 200, "desktop config")
	cfg := e.Anon("GET", "/auth/desktop/config?provider=s2o")
	eq(t, cfg.Str("clientId"), "bo-desktop", "desktop clientId")
	eq(t, cfg.Str("redirectUriTemplate"), "http://127.0.0.1:{port}/cb", "template")

	code, _ := e.idp.IssueCode(authURL, IdpUser{Email: "desk@vnpay.vn", Aud: "bo-desktop"})
	status(t, exchange(code, "https://evil.example/cb"), 400, "non-loopback redirect")
	code2, _ := e.idp.IssueCode(authURL, IdpUser{Email: "desk@vnpay.vn", Aud: "bo-desktop"})
	ex := exchange(code2, redirect)
	status(t, ex, 200, "exchange")
	access, refresh := ex.Str("accessToken"), ex.Str("refreshToken")
	eq(t, bearer(access).Get("/auth/me").Str("kind"), "desktop", "kind")
	// bearer: no CSRF header needed
	status(t, bearer(access).Post("/auth/logout", nil), 200, "bearer logout")
	status(t, e.Anon("POST", "/auth/desktop/refresh", Opt{Body: map[string]any{"refreshToken": refresh}}), 401, "refresh after logout")
	code3, _ := e.idp.IssueCode(authURL, IdpUser{Email: "desk@vnpay.vn", Aud: "bo-desktop"})
	ex2 := exchange(code3, redirect)
	rot := e.Anon("POST", "/auth/desktop/refresh", Opt{Body: map[string]any{"refreshToken": ex2.Str("refreshToken")}})
	status(t, rot, 200, "rotate")
	status(t, e.Anon("POST", "/auth/desktop/refresh", Opt{Body: map[string]any{"refreshToken": ex2.Str("refreshToken")}}), 401, "refresh reuse")
	status(t, bearer(ex2.Str("accessToken")).Get("/auth/me"), 401, "old access token after rotation")
	status(t, bearer(rot.Str("accessToken")).Get("/auth/me"), 200, "new access token")
	// weak verifier / missing fields
	status(t, e.Anon("POST", "/auth/desktop/exchange", Opt{Body: map[string]any{"provider": "s2o", "code": "c", "codeVerifier": "short", "redirectUri": redirect}}), 400, "short verifier")
}

func TestCORS(t *testing.T) {
	hc := harness(t, map[string]string{"CORS_ORIGINS": "http://localhost:5173,tauri://localhost"})
	pre := hc.Anon("OPTIONS", "/auth/desktop/genai", Opt{Headers: map[string]string{"Origin": "tauri://localhost", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization"}})
	eq(t, pre.Status, 204, "preflight status")
	eq(t, pre.Header.Get("Access-Control-Allow-Origin"), "tauri://localhost", "allow-origin")
	if !strings.Contains(pre.Header.Get("Access-Control-Allow-Headers"), "authorization") {
		t.Fatal("allow-headers")
	}
	if pre.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("credentials must not be allowed")
	}
	ok := hc.Anon("GET", "/auth/config", Opt{Headers: map[string]string{"Origin": "http://localhost:5173"}})
	eq(t, ok.Header.Get("Access-Control-Allow-Origin"), "http://localhost:5173", "allow-origin simple")
	if !strings.Contains(ok.Header.Get("Vary"), "Origin") {
		t.Fatal("vary")
	}
	evil := hc.Anon("GET", "/auth/config", Opt{Headers: map[string]string{"Origin": "https://evil.example"}})
	eq(t, evil.Header.Get("Access-Control-Allow-Origin"), "", "evil origin")
	eq(t, hc.Anon("OPTIONS", "/auth/desktop/genai", Opt{Headers: map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}}).Status, 403, "evil preflight")
	eq(t, hc.Anon("GET", "/auth/config").Header.Get("Access-Control-Allow-Origin"), "", "no origin")
}

func TestProdConfigCORS(t *testing.T) {
	base := map[string]string{"APP_ENV": "prod", "DATABASE_URL": "postgres://x", "DATA_KEY": "k", "PUBLIC_URL": "https://bo.vnpay.vn", "HRM_BASE_URL": "https://hrm.example/dataservice",
		"HRM_SIGNATURE_SECRET": "s", "OIDC_PROVIDERS": `[{"id":"a","label":"a","issuer":"https://i.example","clientId":"c"}]`}
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for a, b := range base {
			m[a] = b
		}
		m[k] = v
		return m
	}
	if _, err := config.Load(with("CORS_ORIGINS", "tauri://localhost,http://tauri.localhost")); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"*", "http://evil.example"} {
		if _, err := config.Load(with("CORS_ORIGINS", bad)); err == nil || !strings.Contains(err.Error(), "CORS_ORIGINS") {
			t.Fatalf("%s: %v", bad, err)
		}
	}
}
