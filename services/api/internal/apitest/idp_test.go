package apitest

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// IdpUser is what the mock IdP binds to an authorization code.
type IdpUser struct {
	Email, Name, Sub string
	AuthTime         int64 // 0 = now
	Aud, Issuer      string
	NonceOverride    string
}

type codeEntry struct {
	challenge, nonce, redirect string
	user                       IdpUser
}

// Idp is a mock OIDC provider (discovery, JWKS, token endpoint with PKCE) signing RS256 id_tokens.
type Idp struct {
	srv   *httptest.Server
	key   *rsa.PrivateKey
	mu    sync.Mutex
	codes map[string]codeEntry
	hits  []string
	base  string
}

func startIdp(t *testing.T) *Idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	i := &Idp{key: key, codes: map[string]codeEntry{}}
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "k1"}}, nil)
	pub := jose.JSONWebKey{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}
	i.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i.mu.Lock()
		i.hits = append(i.hits, r.Method+" "+r.URL.Path)
		i.mu.Unlock()
		send := func(code int, v any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(v)
		}
		switch {
		case r.URL.Path == "/.well-known/openid-configuration":
			send(200, map[string]any{"issuer": i.base, "authorization_endpoint": i.base + "/authorize", "token_endpoint": i.base + "/token", "jwks_uri": i.base + "/jwks"})
		case r.URL.Path == "/jwks":
			send(200, map[string]any{"keys": []jose.JSONWebKey{pub}})
		case r.URL.Path == "/token" && r.Method == "POST":
			b, _ := io.ReadAll(r.Body)
			p, _ := url.ParseQuery(string(b))
			i.mu.Lock()
			e, ok := i.codes[p.Get("code")]
			delete(i.codes, p.Get("code"))
			i.mu.Unlock()
			if !ok {
				send(400, map[string]any{"error": "invalid_grant"})
				return
			}
			h := sha256.Sum256([]byte(p.Get("code_verifier")))
			if base64.RawURLEncoding.EncodeToString(h[:]) != e.challenge {
				send(400, map[string]any{"error": "invalid_grant", "error_description": "pkce"})
				return
			}
			if p.Get("redirect_uri") != e.redirect {
				send(400, map[string]any{"error": "invalid_grant", "error_description": "redirect"})
				return
			}
			clientID := p.Get("client_id")
			if user, pass, ok := r.BasicAuth(); ok {
				_ = pass
				clientID, _ = url.QueryUnescape(user)
			}
			now := time.Now().Unix()
			u := e.user
			claims := map[string]any{"email": u.Email, "email_verified": true, "name": orDefault(u.Name, u.Email), "nonce": e.nonce,
				"auth_time": now, "iss": orDefault(u.Issuer, i.base), "aud": orDefault(u.Aud, clientID), "sub": orDefault(u.Sub, u.Email), "iat": now, "exp": now + 300}
			if u.AuthTime != 0 {
				claims["auth_time"] = u.AuthTime
			}
			payload, _ := json.Marshal(claims)
			jws, err := signer.Sign(payload)
			if err != nil {
				send(500, map[string]any{"error": err.Error()})
				return
			}
			tok, _ := jws.CompactSerialize()
			send(200, map[string]any{"id_token": tok, "access_token": "unused", "token_type": "Bearer"})
		default:
			send(404, map[string]any{})
		}
	}))
	i.base = i.srv.URL
	t.Cleanup(i.srv.Close)
	return i
}

func orDefault(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (i *Idp) URL() string { return i.base }
func (i *Idp) Hits() []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]string(nil), i.hits...)
}

// IssueCode is what a real IdP does after the user authenticates: bind a code to the authorize request.
func (i *Idp) IssueCode(authorizeURL string, u IdpUser) (code, state string) {
	q, _ := url.Parse(authorizeURL)
	v := q.Query()
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	code = hex.EncodeToString(b)
	nonce := v.Get("nonce")
	if u.NonceOverride != "" {
		nonce = u.NonceOverride
	}
	i.mu.Lock()
	i.codes[code] = codeEntry{challenge: v.Get("code_challenge"), nonce: nonce, redirect: v.Get("redirect_uri"), user: u}
	i.mu.Unlock()
	return code, v.Get("state")
}

// Proxy is a minimal forward proxy (HTTP + CONNECT) that records what went through it.
type Proxy struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seen []string
}

func startProxy(t *testing.T) *Proxy {
	t.Helper()
	p := &Proxy{}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		if r.Method == http.MethodConnect {
			p.seen = append(p.seen, "CONNECT "+r.Host)
		} else {
			p.seen = append(p.seen, "HTTP "+r.URL.String())
		}
		p.mu.Unlock()
		if r.Method == http.MethodConnect {
			up, err := net.Dial("tcp", r.Host)
			if err != nil {
				http.Error(w, err.Error(), 502)
				return
			}
			hj, _ := w.(http.Hijacker)
			c, _, _ := hj.Hijack()
			_, _ = c.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
			go func() { _, _ = io.Copy(up, c); up.Close() }()
			go func() { _, _ = io.Copy(c, up); c.Close() }()
			return
		}
		out, _ := http.NewRequest(r.Method, r.URL.String(), r.Body)
		out.Header = r.Header.Clone()
		res, err := http.DefaultTransport.RoundTrip(out)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		defer res.Body.Close()
		for k, vs := range res.Header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(res.StatusCode)
		_, _ = io.Copy(w, res.Body)
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *Proxy) URL() string { return p.srv.URL }
func (p *Proxy) Seen() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.seen...)
}
func (p *Proxy) SawHost(host string) bool {
	for _, s := range p.Seen() {
		if strings.Contains(s, host) {
			return true
		}
	}
	return false
}
