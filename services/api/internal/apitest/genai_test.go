package apitest

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"vnpay/tabledb-api/internal/config"
)

const goodTok = "aaaa.bbbb.cccc"

type broker struct {
	srv   *httptest.Server
	mu    sync.Mutex
	hits  []string
	reply func(tok string) (int, any)
}

func startBroker(t *testing.T) *broker {
	b := &broker{reply: func(string) (int, any) { return 500, nil }}
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		b.mu.Lock()
		b.hits = append(b.hits, tok)
		reply := b.reply
		b.mu.Unlock()
		code, body := reply(tok)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}))
	t.Cleanup(b.srv.Close)
	return b
}

func (b *broker) set(f func(string) (int, any)) { b.mu.Lock(); b.reply = f; b.mu.Unlock() }
func (b *broker) hitCount() int                 { b.mu.Lock(); defer b.mu.Unlock(); return len(b.hits) }
func (b *broker) reset()                        { b.mu.Lock(); b.hits = nil; b.mu.Unlock() }
func (b *broker) url() string                   { return b.srv.URL + "/verify" }

func genaiLogin(h *Harness, token string) *Resp {
	return h.Anon("POST", "/auth/desktop/genai", Opt{Body: map[string]any{"token": token}})
}

func okBroker(tok string) (int, any) {
	if tok == goodTok {
		return 200, map[string]any{"email": "Nguyen.Van@VNPAY.vn", "userFullName": "Nguyễn Văn A", "userName": "nguyen.van"}
	}
	return 401, nil
}

func TestGenaiBrokerVerify(t *testing.T) {
	br := startBroker(t)
	h := harness(t, map[string]string{"GENAI_LOGIN_URL": "https://genai.example/create-jwt-token", "GENAI_VERIFY_URL": br.url(), "ALLOWED_EMAIL_DOMAINS": "vnpay.vn", "RATE_LIMIT_LOGIN_PER_MIN": "1000"})

	t.Run("advertises the broker login URL only when fully configured", func(t *testing.T) {
		eq(t, h.Anon("GET", "/auth/config").Str("desktopLoginUrl"), "https://genai.example/create-jwt-token", "desktopLoginUrl")
	})
	t.Run("valid token → desktop bearer session for the email the broker vouches for (lower-cased), refresh works, audit written", func(t *testing.T) {
		br.set(okBroker)
		r := genaiLogin(h, goodTok)
		status(t, r, 200, "login")
		eq(t, r.Str("user.email"), "nguyen.van@vnpay.vn", "email")
		eq(t, r.Str("user.name"), "Nguyễn Văn A", "name")
		me := (&Client{h: h, Bearer: r.Str("accessToken")}).Get("/auth/me")
		eq(t, me.Str("kind"), "desktop", "kind")
		eq(t, me.Str("user.roles.0"), "user", "role")
		status(t, h.Anon("POST", "/auth/desktop/refresh", Opt{Body: map[string]any{"refreshToken": r.Str("refreshToken")}}), 200, "refresh")
		via := Scalar[string](h, "SELECT detail->>'via' FROM audit_log WHERE action='auth.login' ORDER BY seq DESC LIMIT 1")
		eq(t, via, "genai", "audit via")
		if all := Scalar[string](h, "SELECT coalesce(string_agg(detail::text || actor_label,','),'') FROM audit_log"); strings.Contains(all, goodTok) {
			t.Fatal("token leaked into the audit log")
		}
	})
	t.Run("same person logging in again gets the same account (no duplicates)", func(t *testing.T) {
		br.set(okBroker)
		genaiLogin(h, goodTok)
		genaiLogin(h, goodTok)
		eq(t, Scalar[int](h, "SELECT count(*)::int FROM users WHERE email='nguyen.van@vnpay.vn'"), 1, "user rows")
	})
	t.Run("rejected by broker → 401 and a failed-login audit; nothing created", func(t *testing.T) {
		br.set(func(string) (int, any) { return 401, nil })
		before := Scalar[int](h, "SELECT count(*)::int FROM users")
		status(t, genaiLogin(h, "dead.beef.cafe"), 401, "rejected")
		eq(t, Scalar[int](h, "SELECT count(*)::int FROM users"), before, "users created")
		if Scalar[int](h, "SELECT count(*)::int FROM audit_log WHERE action='auth.login_failed'") == 0 {
			t.Fatal("no failed-login audit")
		}
	})
	t.Run("never forwards malformed tokens to the broker (header injection / junk)", func(t *testing.T) {
		br.set(okBroker)
		br.reset()
		for _, tok := range []string{"not-a-jwt-at-all", "a.b", "aaaa.bbbb.cccc\r\nX-Evil: 1", "a.b.c d", strings.Repeat("x", 5000) + ".b.c"} {
			r := genaiLogin(h, tok)
			atLeast(t, r, 400, tok[:min(len(tok), 20)])
		}
		eq(t, br.hitCount(), 0, "broker hits")
	})
	t.Run("enforces the allowed email domain and requires an email in the broker response", func(t *testing.T) {
		br.set(func(string) (int, any) { return 200, map[string]any{"email": "mallory@evil.com", "userFullName": "M"} })
		status(t, genaiLogin(h, goodTok), 403, "foreign domain")
		br.set(func(string) (int, any) { return 200, map[string]any{"userFullName": "no email"} })
		status(t, genaiLogin(h, goodTok), 401, "no email")
		br.set(func(string) (int, any) { return 200, map[string]any{"email": "a b@vnpay.vn"} })
		status(t, genaiLogin(h, goodTok), 401, "malformed email")
	})
	t.Run("broker outage/garbage → 502 (not 401), not a login", func(t *testing.T) {
		br.set(func(string) (int, any) { return 503, nil })
		status(t, genaiLogin(h, goodTok), 502, "503")
		br.set(func(string) (int, any) { return 200, nil })
		status(t, genaiLogin(h, goodTok), 502, "empty 200")
	})
	t.Run("disabled account cannot log in through the broker; unconfigured server refuses", func(t *testing.T) {
		br.set(okBroker)
		id := Scalar[string](h, "SELECT id::text FROM users WHERE email='nguyen.van@vnpay.vn'")
		h.Exec("UPDATE users SET active=false WHERE id=$1", id)
		status(t, genaiLogin(h, goodTok), 403, "disabled")
		h.Exec("UPDATE users SET active=true WHERE id=$1", id)
		h2 := harness(t)
		status(t, genaiLogin(h2, goodTok), 502, "unconfigured")
		if h2.Anon("GET", "/auth/config").Get("desktopLoginUrl") != nil {
			t.Fatal("desktopLoginUrl must be null")
		}
	})
	t.Run("login attempts are rate limited per client", func(t *testing.T) {
		h3 := harness(t, map[string]string{"GENAI_VERIFY_URL": br.url(), "RATE_LIMIT_LOGIN_PER_MIN": "3"})
		br.set(func(string) (int, any) { return 401, nil })
		var codes []int
		for i := 0; i < 5; i++ {
			codes = append(codes, genaiLogin(h3, "aaaa.bbbb.cccc").Status)
		}
		want := []int{401, 401, 401, 429, 429}
		for i := range want {
			if codes[i] != want[i] {
				t.Fatalf("codes %v want %v", codes, want)
			}
		}
		r := genaiLogin(h3, "aaaa.bbbb.cccc")
		eq(t, r.Code(), "RATE_LIMITED", "code")
	})
	t.Run("prod config requires https broker URLs and an email-domain allow-list", func(t *testing.T) {
		base := prodBase()
		with := func(kv ...string) map[string]string {
			m := map[string]string{}
			for k, v := range base {
				m[k] = v
			}
			for i := 0; i < len(kv); i += 2 {
				m[kv[i]] = kv[i+1]
			}
			return m
		}
		if _, err := config.Load(with("GENAI_VERIFY_URL", "https://genai.vnpay.vn/x", "ALLOWED_EMAIL_DOMAINS", "vnpay.vn")); err != nil {
			t.Fatal(err)
		}
		if _, err := config.Load(with("GENAI_VERIFY_URL", "http://genai.vnpay.vn/x", "ALLOWED_EMAIL_DOMAINS", "vnpay.vn")); err == nil || !strings.Contains(err.Error(), "https") {
			t.Fatalf("http verify url: %v", err)
		}
		if _, err := config.Load(with("GENAI_VERIFY_URL", "https://genai.vnpay.vn/x")); err == nil || !strings.Contains(err.Error(), "ALLOWED_EMAIL_DOMAINS") {
			t.Fatalf("missing allow-list: %v", err)
		}
	})
}

func prodBase() map[string]string {
	return map[string]string{"APP_ENV": "prod", "DATABASE_URL": "postgres://x", "DATA_KEY": "k", "PUBLIC_URL": "https://bo.vnpay.vn", "HRM_BASE_URL": "https://hrm.example/dataservice",
		"HRM_SIGNATURE_SECRET": "s", "OIDC_PROVIDERS": `[{"id":"a","label":"a","issuer":"https://i.example","clientId":"c"}]`}
}

func TestGenaiLocalHS256(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = 9
	}
	h := harness(t, map[string]string{"GENAI_LOGIN_URL": "https://genai.example/create-jwt-token", "GENAI_JWT_KEY": base64.StdEncoding.EncodeToString(key), "ALLOWED_EMAIL_DOMAINS": "vnpay.vn", "RATE_LIMIT_LOGIN_PER_MIN": "1000"})
	type opts struct {
		key   []byte
		alg   jose.SignatureAlgorithm
		exp   *int64
		noExp bool
	}
	sign := func(claims map[string]any, o opts) string {
		k := o.key
		if k == nil {
			k = key
		}
		alg := o.alg
		if alg == "" {
			alg = jose.HS256
		}
		if !o.noExp {
			e := time.Now().Add(24 * time.Hour).Unix()
			if o.exp != nil {
				e = *o.exp
			}
			claims["exp"] = e
		}
		claims["iat"] = time.Now().Unix()
		s, err := jose.NewSigner(jose.SigningKey{Algorithm: alg, Key: k}, nil)
		if err != nil {
			t.Fatal(err)
		}
		p, _ := json.Marshal(claims)
		jws, err := s.Sign(p)
		if err != nil {
			t.Fatal(err)
		}
		tok, _ := jws.CompactSerialize()
		return tok
	}
	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

	t.Run("accepts a correctly signed, unexpired token (claims as issued by the broker) with no network call", func(t *testing.T) {
		r := genaiLogin(h, sign(map[string]any{"email": "Tran.B@vnpay.vn", "userFullName": "Trần B", "userName": "tran.b", "preferred_username": "tran.b"}, opts{}))
		status(t, r, 200, "login")
		eq(t, r.Str("user.email"), "tran.b@vnpay.vn", "email")
		eq(t, r.Str("user.name"), "Trần B", "name")
		eq(t, h.Anon("GET", "/auth/config").Str("desktopLoginUrl"), "https://genai.example/create-jwt-token", "login url")
	})
	t.Run("rejects wrong key, tampered payload, expired, no exp, other algorithms, and garbage", func(t *testing.T) {
		good := sign(map[string]any{"email": "a@vnpay.vn"}, opts{})
		parts := strings.Split(good, ".")
		forged := parts[0] + "." + b64(`{"email":"boss@vnpay.vn","exp":9999999999}`) + "." + parts[2]
		past := time.Now().Add(-time.Hour).Unix()
		hs512key := make([]byte, 64)
		for i := range hs512key {
			hs512key[i] = 9
		}
		cases := map[string]string{
			"wrongKey": sign(map[string]any{"email": "a@vnpay.vn"}, opts{key: make([]byte, 32)}),
			"tampered": forged,
			"expired":  sign(map[string]any{"email": "a@vnpay.vn"}, opts{exp: &past}),
			"noExp":    sign(map[string]any{"email": "a@vnpay.vn"}, opts{noExp: true}),
			"hs512":    sign(map[string]any{"email": "a@vnpay.vn"}, opts{alg: jose.HS512, key: hs512key}),
			"algNone":  b64(`{"alg":"none"}`) + "." + parts[1] + ".",
			"garbage":  "aaaa.bbbb.cccc",
		}
		for name, tok := range cases {
			status(t, genaiLogin(h, tok), 401, name)
		}
	})
	t.Run("still enforces the email domain and requires an email claim", func(t *testing.T) {
		status(t, genaiLogin(h, sign(map[string]any{"email": "x@evil.com"}, opts{})), 403, "domain")
		status(t, genaiLogin(h, sign(map[string]any{"userName": "no-email"}, opts{})), 401, "no email")
	})
	t.Run("HTTP verify mode refuses an HTML page even with status 200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>ok</html>"))
		}))
		defer srv.Close()
		hh := harness(t, map[string]string{"GENAI_VERIFY_URL": srv.URL + "/verify/me", "RATE_LIMIT_LOGIN_PER_MIN": "1000"})
		r := genaiLogin(hh, "aaaa.bbbb.cccc")
		status(t, r, 502, "html answer")
		if !regexp.MustCompile("JSON").MatchString(r.Str("error.message")) {
			t.Fatalf("message %q", r.Str("error.message"))
		}
	})
}

func TestGenaiDevUnverified(t *testing.T) {
	hd := harness(t, map[string]string{"GENAI_LOGIN_URL": "https://genai.example/create-jwt-token", "GENAI_DEV_TRUST_UNVERIFIED": "1", "ALLOWED_EMAIL_DOMAINS": "vnpay.vn", "RATE_LIMIT_LOGIN_PER_MIN": "1000"})
	forged := func(c map[string]any) string {
		p, _ := json.Marshal(c)
		return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`)) + "." + base64.RawURLEncoding.EncodeToString(p) + ".c2ln"
	}
	future := time.Now().Add(time.Hour).Unix()
	status(t, genaiLogin(hd, forged(map[string]any{"email": "dev@vnpay.vn", "userFullName": "Dev", "exp": future})), 200, "unsigned token accepted in dev mode")
	status(t, genaiLogin(hd, forged(map[string]any{"email": "dev@vnpay.vn", "exp": 1})), 401, "expired")
	status(t, genaiLogin(hd, forged(map[string]any{"email": "dev@vnpay.vn"})), 401, "no exp")
	status(t, genaiLogin(hd, forged(map[string]any{"email": "x@evil.com", "exp": future})), 403, "domain")
	if hd.Anon("GET", "/auth/config").Get("desktopLoginUrl") == nil {
		t.Fatal("desktopLoginUrl should be advertised")
	}
	base := prodBase()
	base["GENAI_DEV_TRUST_UNVERIFIED"] = "1"
	if _, err := config.Load(base); err == nil || !strings.Contains(err.Error(), "GENAI_DEV_TRUST_UNVERIFIED") {
		t.Fatalf("prod must refuse dev trust: %v", err)
	}
}
