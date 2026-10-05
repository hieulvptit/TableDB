package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/httpx"
)

type Discovery struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	JwksURI               string `json:"jwks_uri"`
}

type IDClaims struct {
	Sub           string
	Email         string
	EmailVerified bool
	Name          string
	AuthTime      int64
	Nonce         string
	HasNonce      bool
}

func PKCEChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func NewVerifier() string {
	b := make([]byte, 48)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// OIDC does discovery, the authorization-code exchange and ID-token verification for the configured providers.
type OIDC struct {
	Out *httpx.Outbound

	mu   sync.Mutex
	disc map[string]discEntry
	jwks map[string]jwksEntry
}

type discEntry struct {
	at time.Time
	d  Discovery
}
type jwksEntry struct {
	at  time.Time
	set jose.JSONWebKeySet
}

func NewOIDC(out *httpx.Outbound) *OIDC {
	return &OIDC{Out: out, disc: map[string]discEntry{}, jwks: map[string]jwksEntry{}}
}

func (o *OIDC) get(ctx context.Context, url string) (*http.Response, context.CancelFunc, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, nil, err
	}
	return o.Out.Do(ctx, httpx.HopOIDC, req, 0)
}

func (o *OIDC) Discovery(ctx context.Context, p *config.OidcProvider) (Discovery, error) {
	o.mu.Lock()
	hit, ok := o.disc[p.ID]
	o.mu.Unlock()
	if ok && time.Since(hit.at) < time.Hour {
		return hit.d, nil
	}
	var d Discovery
	if !(p.AuthorizationEndpoint != "" && p.TokenEndpoint != "" && p.JwksURI != "") {
		res, cancel, err := o.get(ctx, strings.TrimSuffix(p.Issuer, "/")+"/.well-known/openid-configuration")
		if err != nil {
			return d, apperr.NewUpstream("OIDC discovery failed (" + oneLineErr(err) + ")")
		}
		defer cancel()
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return d, apperr.NewUpstream(fmt.Sprintf("OIDC discovery failed (%d)", res.StatusCode))
		}
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&d); err != nil {
			return d, apperr.NewUpstream("OIDC discovery failed (bad JSON)")
		}
		if strings.TrimSuffix(d.Issuer, "/") != strings.TrimSuffix(p.Issuer, "/") {
			return d, apperr.NewUpstream("OIDC issuer mismatch")
		}
	}
	full := Discovery{Issuer: p.Issuer, AuthorizationEndpoint: first(p.AuthorizationEndpoint, d.AuthorizationEndpoint),
		TokenEndpoint: first(p.TokenEndpoint, d.TokenEndpoint), JwksURI: first(p.JwksURI, d.JwksURI)}
	o.mu.Lock()
	o.disc[p.ID] = discEntry{at: time.Now(), d: full}
	o.mu.Unlock()
	return full, nil
}

func first(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func oneLineErr(err error) string { return strings.ReplaceAll(err.Error(), "\n", " ") }

type AuthorizeOpts struct {
	RedirectURI string
	State       string
	Challenge   string
	Nonce       string
	Stepup      bool
	ClientID    string
}

func (o *OIDC) AuthorizeURL(ctx context.Context, p *config.OidcProvider, a AuthorizeOpts) (string, error) {
	d, err := o.Discovery(ctx, p)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(d.AuthorizationEndpoint)
	if err != nil {
		return "", apperr.NewUpstream("bad authorization endpoint")
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", first(a.ClientID, p.ClientID))
	q.Set("redirect_uri", a.RedirectURI)
	q.Set("scope", strings.Join(p.Scopes, " "))
	q.Set("state", a.State)
	q.Set("nonce", a.Nonce)
	q.Set("code_challenge", a.Challenge)
	q.Set("code_challenge_method", "S256")
	if a.Stepup {
		q.Set("prompt", "login")
		q.Set("max_age", "0")
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

type ExchangeOpts struct {
	Code, Verifier, RedirectURI string
	Desktop                     bool
}

// Exchange trades the code for an id_token. Web = confidential client (HTTP Basic); desktop = public client + PKCE.
func (o *OIDC) Exchange(ctx context.Context, p *config.OidcProvider, e ExchangeOpts) (string, error) {
	d, err := o.Discovery(ctx, p)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {e.Code}, "redirect_uri": {e.RedirectURI}, "code_verifier": {e.Verifier}}
	req, _ := http.NewRequest("POST", d.TokenEndpoint, nil)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	switch {
	case e.Desktop:
		if p.DesktopClientID == "" {
			return "", apperr.Validation("desktop login is not configured for this provider")
		}
		form.Set("client_id", p.DesktopClientID)
	case p.ClientSecret != "":
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(formEscape(p.ClientID)+":"+formEscape(p.ClientSecret))))
	default:
		form.Set("client_id", p.ClientID)
	}
	body := form.Encode()
	req.Body = io.NopCloser(strings.NewReader(body))
	req.ContentLength = int64(len(body))
	res, cancel, err := o.Out.Do(ctx, httpx.HopOIDC, req, 0)
	if err != nil {
		return "", apperr.NewUpstream("token endpoint unreachable")
	}
	defer cancel()
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", apperr.Unauth(fmt.Sprintf("token exchange failed (%d)", res.StatusCode))
	}
	var j struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&j); err != nil || j.IDToken == "" {
		return "", apperr.Unauth("no id_token returned")
	}
	return j.IDToken, nil
}

// formEscape is encodeURIComponent for the Basic credentials (RFC 6749 §2.3.1 asks for form-urlencoding; Node used encodeURIComponent).
func formEscape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func (o *OIDC) keySet(ctx context.Context, p *config.OidcProvider, force bool) (jose.JSONWebKeySet, error) {
	o.mu.Lock()
	hit, ok := o.jwks[p.ID]
	o.mu.Unlock()
	if ok && !force && time.Since(hit.at) < 10*time.Minute {
		return hit.set, nil
	}
	d, err := o.Discovery(ctx, p)
	if err != nil {
		return jose.JSONWebKeySet{}, err
	}
	res, cancel, err := o.get(ctx, d.JwksURI)
	if err != nil {
		return jose.JSONWebKeySet{}, apperr.NewUpstream("JWKS fetch failed (" + oneLineErr(err) + ")")
	}
	defer cancel()
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return jose.JSONWebKeySet{}, apperr.NewUpstream(fmt.Sprintf("JWKS fetch failed (%d)", res.StatusCode))
	}
	var set jose.JSONWebKeySet
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&set); err != nil {
		return set, apperr.NewUpstream("JWKS fetch failed (bad JSON)")
	}
	o.mu.Lock()
	o.jwks[p.ID] = jwksEntry{at: time.Now(), set: set}
	o.mu.Unlock()
	return set, nil
}

var idTokenAlgs = []jose.SignatureAlgorithm{jose.RS256, jose.RS384, jose.RS512, jose.PS256, jose.PS384, jose.PS512, jose.ES256, jose.ES384, jose.ES512}

type VerifyOpts struct {
	Nonce    *string // nil = do not check
	Audience string
}

func (o *OIDC) VerifyIDToken(ctx context.Context, p *config.OidcProvider, token string, v VerifyOpts) (IDClaims, error) {
	bad := apperr.Unauth("invalid id_token")
	jws, err := jose.ParseSigned(token, idTokenAlgs)
	if err != nil || len(jws.Signatures) != 1 {
		return IDClaims{}, bad
	}
	var payload []byte
	for attempt := 0; attempt < 2; attempt++ {
		set, err := o.keySet(ctx, p, attempt == 1)
		if err != nil {
			return IDClaims{}, bad // like jose: any failure while verifying surfaces as an invalid token
		}
		kid := jws.Signatures[0].Header.KeyID
		var cands []jose.JSONWebKey
		if kid != "" {
			cands = set.Key(kid)
		} else {
			cands = set.Keys
		}
		for _, k := range cands {
			if k.Use != "" && k.Use != "sig" {
				continue
			}
			if b, err := jws.Verify(k); err == nil {
				payload = b
				break
			}
		}
		if payload != nil {
			break
		}
		// unknown key id → the IdP may have rotated: refresh the key set once
	}
	if payload == nil {
		return IDClaims{}, bad
	}
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var c map[string]any
	if err := dec.Decode(&c); err != nil {
		return IDClaims{}, bad
	}
	if iss, _ := c["iss"].(string); iss != p.Issuer {
		return IDClaims{}, bad
	}
	if !audMatches(c["aud"], v.Audience) {
		return IDClaims{}, bad
	}
	now := time.Now()
	const tol = 30 * time.Second
	exp, ok := numClaim(c["exp"])
	if !ok || !time.Unix(int64(exp), 0).Add(tol).After(now) {
		return IDClaims{}, bad
	}
	if nbf, ok := numClaim(c["nbf"]); ok && time.Unix(int64(nbf), 0).Add(-tol).After(now) {
		return IDClaims{}, bad
	}
	nonce, hasNonce := c["nonce"].(string)
	if v.Nonce != nil && (!hasNonce || nonce != *v.Nonce) {
		return IDClaims{}, apperr.Unauth("nonce mismatch")
	}
	email, _ := c["email"].(string)
	email = strings.ToLower(email)
	sub := claimString(c["sub"])
	if sub == "" || email == "" {
		return IDClaims{}, apperr.Unauth("id_token lacks sub/email")
	}
	ev, _ := c["email_verified"].(bool)
	name, _ := c["name"].(string)
	var authTime int64
	if at, ok := numClaim(c["auth_time"]); ok {
		authTime = int64(at)
	} else if iat, ok := numClaim(c["iat"]); ok {
		authTime = int64(iat)
	}
	return IDClaims{Sub: sub, Email: email, EmailVerified: ev, Name: name, AuthTime: authTime, Nonce: nonce, HasNonce: hasNonce}, nil
}

func claimString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	}
	return ""
}

func numClaim(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

func audMatches(v any, want string) bool {
	switch a := v.(type) {
	case string:
		return a == want
	case []any:
		for _, e := range a {
			if s, ok := e.(string); ok && s == want {
				return true
			}
		}
	}
	return false
}
