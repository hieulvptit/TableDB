package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	jose "github.com/go-jose/go-jose/v4"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/httpx"
	"vnpay/tabledb-api/internal/reqmeta"
)

type Identity struct{ Email, Name string }

// GenaiVerifier turns the broker's JWT (genai.vnpay.vn SSO) into an identity.
type GenaiVerifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

// jwtShaped mirrors /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{0,2048}$/ (RE2 caps repeats at 1000).
func jwtShaped(t string) bool {
	parts := strings.Split(t, ".")
	if len(parts) != 3 {
		return false
	}
	for i, p := range parts {
		min := 1
		if i == 2 {
			min = 0
		}
		if len(p) < min || len(p) > 2048 {
			return false
		}
		for j := 0; j < len(p); j++ {
			c := p[j]
			if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
				return false
			}
		}
	}
	return true
}

// getPath reads a dotted path ("a.0.b") out of decoded JSON.
func getPath(o any, path string) any {
	cur := o
	for _, k := range strings.Split(path, ".") {
		switch x := cur.(type) {
		case map[string]any:
			cur = x[k]
		case []any:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(x) {
				return nil
			}
			cur = x[i]
		default:
			return nil
		}
	}
	return cur
}

// IdentityFrom validates the email (shape + allowed domains) and builds the identity.
func IdentityFrom(email, name any, s config.Genai) (Identity, error) {
	e, ok := email.(string)
	if !ok || !validEmailShape(e) {
		return Identity{}, apperr.Unauth("SSO broker did not return an email")
	}
	lower := strings.ToLower(e)
	if len(s.AllowedEmailDomains) > 0 {
		dom := lower[strings.LastIndex(lower, "@")+1:]
		found := false
		for _, d := range s.AllowedEmailDomains {
			if d == dom {
				found = true
			}
		}
		if !found {
			return Identity{}, apperr.NewForbidden("email domain is not allowed")
		}
	}
	n := ""
	if ns, ok := name.(string); ok {
		n = ns
		if r := []rune(n); len(r) > 200 {
			n = string(r[:200])
		}
	}
	return Identity{Email: lower, Name: n}, nil
}

// validEmailShape = /^[^\s@]{1,64}@[^\s@]{1,255}$/
func validEmailShape(e string) bool {
	at := strings.IndexByte(e, '@')
	if at < 0 || strings.Count(e, "@") != 1 {
		return false
	}
	l, d := e[:at], e[at+1:]
	ok := func(s string, max int) bool {
		n := utf8.RuneCountInString(s)
		if n < 1 || n > max {
			return false
		}
		for _, r := range s {
			if unicode.IsSpace(r) {
				return false
			}
		}
		return true
	}
	return ok(l, 64) && ok(d, 255)
}

// ---- HTTP verify mode: ask the broker over HTTPS.
type HTTPGenai struct {
	Out *httpx.Outbound
	S   config.Genai
}

func (g *HTTPGenai) Verify(ctx context.Context, token string) (Identity, error) {
	if g.S.VerifyURL == "" {
		return Identity{}, apperr.NewUpstream("genai login is not configured (GENAI_JWT_KEY or GENAI_VERIFY_URL). See docs/VNPAY-INPUTS.md §6")
	}
	if !jwtShaped(token) {
		return Identity{}, apperr.Unauth("invalid token")
	}
	req, err := http.NewRequest("GET", g.S.VerifyURL, nil)
	if err != nil {
		slog.ErrorContext(ctx, "genai.verify failed", "stage", "request", "broker", brokerEndpoint(g.S.VerifyURL), "cause", "invalid_verify_url")
		return Identity{}, apperr.NewUpstream("cannot reach the SSO broker")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	started := time.Now()
	meta, _ := reqmeta.From(ctx)
	log := slog.Default().With("request_id", meta.RequestID, "method", "GET", "url", brokerURL(g.S.VerifyURL))
	route, proxy, proxyAuth := g.Out.RouteInfo(httpx.HopGenai)
	log.InfoContext(ctx, "genai.verify request", "headers", brokerHeaders(req.Header), "body", "", "body_bytes", 0, "route", route, "proxy_url", proxy, "proxy_auth_configured", proxyAuth, "timeout_seconds", 10)
	res, cancel, err := g.Out.Do(ctx, httpx.HopGenai, req, 10*time.Second)
	if err != nil {
		attrs := []any{"stage", "transport", "broker", brokerEndpoint(g.S.VerifyURL), "elapsed_ms", time.Since(started).Milliseconds(), "timeout_seconds", 10}
		attrs = append(attrs, "error", brokerDiagnosticText(err.Error(), token, g.S.VerifyURL), "response_received", false)
		log.ErrorContext(ctx, "genai.verify failed", append(attrs, brokerErrorAttrs(err)...)...)
		return Identity{}, apperr.NewUpstream("cannot reach the SSO broker")
	}
	defer cancel()
	defer res.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	finalURL := g.S.VerifyURL
	if res.Request != nil && res.Request.URL != nil {
		finalURL = res.Request.URL.String()
	}
	responseAttrs := []any{"final_url", brokerURL(finalURL), "http_status", res.StatusCode, "status", res.Status, "headers", brokerHeaders(res.Header), "content_type", res.Header.Get("Content-Type"), "server", res.Header.Get("Server"), "location", brokerURL(res.Header.Get("Location")), "elapsed_ms", time.Since(started).Milliseconds(), "response_body", brokerBodyPreview(raw, token), "response_body_bytes", len(raw), "response_body_truncated", len(raw) > 1<<20, "content_length", res.ContentLength}
	log.InfoContext(ctx, "genai.verify response", responseAttrs...)
	if readErr != nil {
		log.ErrorContext(ctx, "genai.verify failed", "stage", "read_response", "error", brokerDiagnosticText(readErr.Error(), token, g.S.VerifyURL))
		return Identity{}, apperr.NewUpstream("cannot read the SSO broker response")
	}
	if len(raw) > 1<<20 {
		log.ErrorContext(ctx, "genai.verify failed", "stage", "response", "cause", "response_too_large")
		return Identity{}, apperr.NewUpstream("SSO broker response is too large")
	}
	if res.StatusCode == 401 || res.StatusCode == 403 {
		slog.WarnContext(ctx, "genai.verify rejected", "broker", brokerEndpoint(g.S.VerifyURL), "http_status", res.StatusCode, "cause", "broker_rejected_token")
		return Identity{}, apperr.Unauth("token rejected by the SSO broker")
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		slog.ErrorContext(ctx, "genai.verify failed", "stage", "response", "broker", brokerEndpoint(g.S.VerifyURL), "http_status", res.StatusCode)
		return Identity{}, apperr.NewUpstream("SSO broker HTTP " + strconv.Itoa(res.StatusCode))
	}
	// a web page (SPA catch-all, login redirect…) is NOT a verification answer, even with HTTP 200
	if !strings.HasPrefix(strings.ToLower(res.Header.Get("Content-Type")), "application/json") {
		slog.ErrorContext(ctx, "genai.verify failed", "stage", "response", "broker", brokerEndpoint(g.S.VerifyURL), "cause", "unexpected_content_type", "content_type", res.Header.Get("Content-Type"))
		return Identity{}, apperr.NewUpstream("SSO broker did not answer with JSON — check GENAI_VERIFY_URL")
	}
	var body any
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&body); err != nil {
		slog.ErrorContext(ctx, "genai.verify failed", "stage", "response", "broker", brokerEndpoint(g.S.VerifyURL), "cause", "invalid_json")
		return Identity{}, apperr.NewUpstream("SSO broker returned a non-JSON response")
	}
	return IdentityFrom(getPath(body, g.S.EmailPath), getPath(body, g.S.NamePath), g.S)
}

// ---- Local mode: verify the broker's HS256 JWT with the shared key (GENAI_JWT_KEY, base64).
type LocalJWTGenai struct {
	key []byte
	S   config.Genai
}

func NewLocalJWTGenai(base64Key string, s config.Genai) (*LocalJWTGenai, error) {
	k, err := decodeKey(base64Key)
	if err != nil || len(k) < 16 {
		return nil, apperr.NewInternal("GENAI_JWT_KEY must be a base64 secret of at least 16 bytes")
	}
	return &LocalJWTGenai{key: k, S: s}, nil
}

func decodeKey(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(s)
}

func (g *LocalJWTGenai) Verify(_ context.Context, token string) (Identity, error) {
	if !jwtShaped(token) {
		return Identity{}, apperr.Unauth("invalid token")
	}
	rejected := apperr.Unauth("token rejected")
	jws, err := jose.ParseSigned(token, []jose.SignatureAlgorithm{jose.HS256}) // pins HS256: none/HS512/RS256… are refused
	if err != nil || len(jws.Signatures) != 1 {
		return Identity{}, rejected
	}
	payload, err := jws.Verify(g.key)
	if err != nil {
		return Identity{}, rejected
	}
	claims, ok := decodeClaims(payload)
	if !ok {
		return Identity{}, rejected
	}
	exp, ok := numClaim(claims["exp"])
	if !ok || !time.Unix(int64(exp), 0).Add(30*time.Second).After(time.Now()) {
		return Identity{}, rejected // exp is required and enforced (broker bug F8 accepted expired tokens)
	}
	if nbf, ok := numClaim(claims["nbf"]); ok && time.Unix(int64(nbf), 0).Add(-30*time.Second).After(time.Now()) {
		return Identity{}, rejected
	}
	return IdentityFrom(getPath(claims, g.S.EmailPath), getPath(claims, g.S.NamePath), g.S)
}

func decodeClaims(payload []byte) (map[string]any, bool) {
	dec := json.NewDecoder(strings.NewReader(string(payload)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, false
	}
	return m, true
}

// ---- DEV ONLY: reads claims WITHOUT checking the signature.
type DevUnverifiedGenai struct{ S config.Genai }

func (g *DevUnverifiedGenai) Verify(_ context.Context, token string) (Identity, error) {
	if !jwtShaped(token) {
		return Identity{}, apperr.Unauth("invalid token")
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
	if err != nil {
		return Identity{}, apperr.Unauth("invalid token")
	}
	claims, ok := decodeClaims(b)
	if !ok {
		return Identity{}, apperr.Unauth("invalid token")
	}
	exp, ok := numClaim(claims["exp"])
	if !ok || time.Unix(int64(exp), 0).Before(time.Now()) {
		return Identity{}, apperr.Unauth("token expired")
	}
	slog.Warn("[SECURITY][DEV ONLY] genai token accepted WITHOUT signature verification (GENAI_DEV_TRUST_UNVERIFIED=1)")
	return IdentityFrom(getPath(claims, g.S.EmailPath), getPath(claims, g.S.NamePath), g.S)
}

// NewGenaiVerifier picks the mode like makeGenaiVerifier: local key > dev-unverified > HTTP verify.
func NewGenaiVerifier(out *httpx.Outbound, s config.Genai) (GenaiVerifier, error) {
	switch {
	case s.JWTKey != "":
		slog.Info("genai.verifier configured", "mode", "local_hs256", "key_source", "GENAI_JWT_KEY")
		return NewLocalJWTGenai(s.JWTKey, s)
	case s.DevTrustUnverified:
		slog.Warn("genai.verifier configured", "mode", "dev_unverified")
		return &DevUnverifiedGenai{S: s}, nil
	}
	slog.Info("genai.verifier configured", "mode", "http_verify", "broker", brokerEndpoint(s.VerifyURL), "key_source", "none", "configured", s.VerifyURL != "")
	return &HTTPGenai{Out: out, S: s}, nil
}
