package auth

import (
	"strings"
	"testing"

	"vnpay/tabledb-api/internal/config"
)

func TestJWTShape(t *testing.T) {
	good := []string{"aaaa.bbbb.cccc", "a.b.", "A-_9.B.c"}
	bad := []string{"", "a.b", "a..c", ".b.c", "a.b.c.d", "aaaa.bbbb.cccc\r\nX-Evil: 1", "a.b.c d", "a.b.c\n", strings.Repeat("x", 2049) + ".b.c", "a.b.c=", "ä.b.c"}
	for _, g := range good {
		if !jwtShaped(g) {
			t.Errorf("rejected %q", g)
		}
	}
	for _, b := range bad {
		if jwtShaped(b) {
			t.Errorf("accepted %q", b)
		}
	}
	if !jwtShaped(strings.Repeat("x", 2048) + ".b." + strings.Repeat("y", 2048)) {
		t.Error("max-size token rejected")
	}
}

func TestGetPath(t *testing.T) {
	o := map[string]any{"a": []any{map[string]any{"b": 1.0}}, "email": "x@y.z", "n": nil}
	if getPath(o, "a.0.b") != 1.0 || getPath(o, "email") != "x@y.z" || getPath(o, "a.1.b") != nil || getPath(o, "a.x") != nil || getPath(o, "n.q") != nil || getPath(o, "zz") != nil {
		t.Fatal("getPath")
	}
}

func TestIdentityFrom(t *testing.T) {
	s := config.Genai{AllowedEmailDomains: []string{"vnpay.vn"}}
	id, err := IdentityFrom("Nguyen.Van@VNPAY.vn", "Nguyễn Văn A", s)
	if err != nil || id.Email != "nguyen.van@vnpay.vn" || id.Name != "Nguyễn Văn A" {
		t.Fatalf("%+v %v", id, err)
	}
	for _, e := range []any{nil, 5, "", "a b@vnpay.vn", "a@@vnpay.vn", "noat", "@vnpay.vn", "a@", strings.Repeat("a", 65) + "@vnpay.vn", "a@vnpay.vn\n"} {
		if _, err := IdentityFrom(e, "n", s); err == nil {
			t.Errorf("accepted email %v", e)
		}
	}
	if _, err := IdentityFrom("a@evil.com", "n", s); err == nil || !strings.Contains(err.Error(), "FORBIDDEN") {
		t.Fatalf("domain: %v", err)
	}
	long := strings.Repeat("é", 300)
	if id, _ := IdentityFrom("a@vnpay.vn", long, config.Genai{}); len([]rune(id.Name)) != 200 {
		t.Fatalf("name not clipped: %d", len([]rune(id.Name)))
	}
	if id, _ := IdentityFrom("a@anything.io", 42, config.Genai{}); id.Name != "" || id.Email != "a@anything.io" {
		t.Fatalf("no allow-list: %+v", id)
	}
}

func TestPKCE(t *testing.T) {
	// RFC 7636 appendix B
	if got := PKCEChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatal(got)
	}
	if a, b := NewVerifier(), NewVerifier(); a == b || len(a) < 43 {
		t.Fatal("verifier")
	}
}
