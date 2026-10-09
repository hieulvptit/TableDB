package auth

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"

	"vnpay/tabledb-api/internal/shared"
)

// Retain the actual path and nonsecret query parameters for troubleshooting.
func brokerURL(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "invalid_url"
	}
	u.User = nil
	u.Fragment = ""
	q := u.Query()
	for k := range q {
		if shared.IsSensitiveKey(k) || strings.Contains(strings.ToLower(k), "key") || strings.Contains(strings.ToLower(k), "secret") {
			q.Set(k, "[REDACTED]")
		}
	}
	u.RawQuery = q.Encode()
	return shared.RedactSecrets(u.String())
}

var diagnosticURLs = regexp.MustCompile(`https?://[^\s<>"']+`)
var diagnosticSecrets = regexp.MustCompile(`(?i)(["']?(?:password|secret|token|access_token|refresh_token|api_key|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,<>}]+`)

func brokerDiagnosticText(text, token, verifyURL string) string {
	if token != "" {
		text = strings.ReplaceAll(text, token, "[REDACTED]")
	}
	if verifyURL != "" {
		text = strings.ReplaceAll(text, verifyURL, brokerURL(verifyURL))
	}
	text = diagnosticURLs.ReplaceAllStringFunc(text, brokerURL)
	text = diagnosticSecrets.ReplaceAllString(text, "${1}[REDACTED]")
	return shared.RedactSecrets(text)
}

func brokerBodyPreview(raw []byte, token string) string {
	var body any
	text := string(raw)
	if json.Unmarshal(raw, &body) == nil {
		clean, _ := json.Marshal(shared.RedactObject(body))
		text = string(clean)
	}
	text = brokerDiagnosticText(text, token, "")
	if len(text) > 1<<20 {
		text = text[:1<<20] + "...[truncated]"
	}
	return text
}

func brokerHeaders(headers http.Header) map[string][]string {
	clean := make(map[string][]string, len(headers))
	for name, values := range headers {
		lower := strings.ToLower(name)
		if shared.IsSensitiveKey(name) || strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "key") || lower == "proxy-authorization" || lower == "www-authenticate" || lower == "proxy-authenticate" {
			clean[name] = []string{"[REDACTED]"}
			continue
		}
		for _, value := range values {
			clean[name] = append(clean[name], brokerDiagnosticText(value, "", ""))
		}
	}
	return clean
}

// Only log the destination origin: userinfo, paths, query and fragments may contain secrets.
func brokerEndpoint(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "unconfigured_or_invalid"
	}
	return u.Scheme + "://" + u.Host
}

// Do not log raw transport errors: url.Error and proxy configuration errors can
// include credentials or query tokens. Extract network facts from known types.
func brokerErrorAttrs(err error) []any {
	attrs := []any{"error_type", fmt.Sprintf("%T", err)}
	var ue *url.Error
	if errors.As(err, &ue) {
		attrs = append(attrs, "operation", ue.Op, "failed_destination", brokerEndpoint(ue.URL))
	}
	var ne net.Error
	if errors.As(err, &ne) {
		attrs = append(attrs, "timeout", ne.Timeout())
	}
	var dns *net.DNSError
	var op *net.OpError
	if errors.As(err, &op) {
		attrs = append(attrs, "network_operation", op.Op, "network", op.Net)
		if op.Addr != nil {
			attrs = append(attrs, "remote_address", op.Addr.String())
		}
	}
	var errno syscall.Errno
	var unknownCA x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalidCert x509.CertificateInvalidError
	cause := "transport_error"
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		cause = "deadline_exceeded"
	case errors.Is(err, context.Canceled):
		cause = "request_canceled"
	case errors.As(err, &dns):
		cause = "dns_error"
		attrs = append(attrs, "dns_name", dns.Name, "dns_server", dns.Server, "dns_not_found", dns.IsNotFound)
	case errors.As(err, &errno):
		cause = errno.Error()
	case errors.As(err, &unknownCA):
		cause = "tls_unknown_certificate_authority"
	case errors.As(err, &hostname):
		cause = "tls_hostname_mismatch"
	case errors.As(err, &invalidCert):
		cause = "tls_invalid_certificate"
		attrs = append(attrs, "certificate_reason", int(invalidCert.Reason))
	case strings.Contains(err.Error(), "Proxy Authentication Required"):
		cause = "proxy_authentication_required"
	}
	return append(attrs, "cause", cause)
}
