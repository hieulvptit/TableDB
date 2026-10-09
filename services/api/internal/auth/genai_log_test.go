package auth

import (
	"bytes"
	"context"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"syscall"
	"testing"

	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/httpx"
)

func TestBrokerDiagnosticsExcludeURLSecrets(t *testing.T) {
	raw := "https://secret-user:secret-password@genai.example/secret-path?token=secret-token#secret-fragment"
	if got := brokerEndpoint(raw); got != "https://genai.example" {
		t.Fatalf("destination = %q", got)
	}
	err := &url.Error{Op: "Get", URL: raw, Err: &net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 443}, Err: syscall.ECONNREFUSED}}
	got := fmt.Sprint(brokerErrorAttrs(err))
	if strings.Contains(got, "secret-") || !strings.Contains(got, "connection refused") || !strings.Contains(got, "127.0.0.1:443") {
		t.Fatalf("unsafe or incomplete diagnostics: %s", got)
	}
	// Unknown errors can also contain a complete credential-bearing proxy URL.
	if got := fmt.Sprint(brokerErrorAttrs(fmt.Errorf("invalid proxy %s", raw))); strings.Contains(got, "secret-") {
		t.Fatalf("unknown error leaked secrets: %s", got)
	}
}

func TestHTTPGenaiLogsResponseWithoutBreakingVerification(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	for _, status := range []int{200, 502} {
		logs.Reset()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer a.b.c" {
				t.Error("missing bearer token")
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			fmt.Fprint(w, `{"email":"user@vnpay.vn","userFullName":"Test","error":"bad gateway","token":"a.b.c"}`)
		}))
		g := &HTTPGenai{Out: httpx.NewOutbound(nil), S: config.Genai{VerifyURL: server.URL + "/verify/me", EmailPath: "email", NamePath: "userFullName"}}
		id, err := g.Verify(context.Background(), "a.b.c")
		server.Close()
		if status == 200 && (err != nil || id.Email != "user@vnpay.vn") {
			t.Fatalf("verification: %+v %v", id, err)
		}
		if status == 502 && (err == nil || !strings.Contains(err.Error(), "SSO broker HTTP 502")) {
			t.Fatalf("status: %v", err)
		}
		got := logs.String()
		if !strings.Contains(got, "/verify/me") || !strings.Contains(got, `"http_status":`+fmt.Sprint(status)) || !strings.Contains(got, "response_body") || strings.Contains(got, "a.b.c") {
			t.Fatalf("incomplete or unsafe logs: %s", got)
		}
	}
}

func TestBrokerDiagnosticCauses(t *testing.T) {
	for _, tc := range []struct {
		err   error
		cause string
	}{
		{context.DeadlineExceeded, "deadline_exceeded"},
		{context.Canceled, "request_canceled"},
		{&net.DNSError{Name: "genai.example", IsNotFound: true}, "dns_error"},
		{x509.UnknownAuthorityError{}, "tls_unknown_certificate_authority"},
		{fmt.Errorf("Proxy Authentication Required"), "proxy_authentication_required"},
	} {
		attrs := brokerErrorAttrs(&url.Error{Op: "Get", URL: "https://genai.example", Err: tc.err})
		if got := attrs[len(attrs)-1]; got != tc.cause {
			t.Errorf("%T: cause = %v, want %s", tc.err, got, tc.cause)
		}
	}
}

func TestBrokerURLAndResponsePreview(t *testing.T) {
	got := brokerURL("https://user:password@genai.example/verify/me?token=secret&mode=json")
	if !strings.Contains(got, "/verify/me") || !strings.Contains(got, "mode=json") || strings.Contains(got, "password") || strings.Contains(got, "secret") {
		t.Fatalf("URL diagnostics: %s", got)
	}
	for _, body := range []string{
		`{"error":"bad gateway","token":"sensitive-value","nested":{"password":"sensitive-value"}}`,
		`<html>502 Bad Gateway token=sensitive-value</html>`,
		`request failed sensitive-value`,
	} {
		got := brokerBodyPreview([]byte(body), "sensitive-value")
		if strings.Contains(got, "sensitive-value") {
			t.Fatalf("body leaked token: %s", got)
		}
	}
	if got := brokerBodyPreview([]byte(strings.Repeat("x", (1<<20)+100)), ""); !strings.HasSuffix(got, "...[truncated]") {
		t.Fatal("unbounded response preview")
	}
}

func TestBrokerHeaders(t *testing.T) {
	got := brokerHeaders(http.Header{"Authorization": {"Bearer sensitive"}, "Set-Cookie": {"sid=sensitive"}, "Content-Type": {"application/json"}, "X-Request-Id": {"upstream-123"}})
	if fmt.Sprint(got["Authorization"]) != "[[REDACTED]]" || fmt.Sprint(got["Set-Cookie"]) != "[[REDACTED]]" || fmt.Sprint(got["Content-Type"]) != "[application/json]" || strings.Contains(fmt.Sprint(got), "sensitive") {
		t.Fatalf("headers: %v", got)
	}
}
