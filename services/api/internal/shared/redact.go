package shared

import (
	"regexp"
	"strings"
)

var sensitiveKeys = regexp.MustCompile(`(?i)^(pass(word)?|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie|credential|access_token|refresh_token|id_token|client_secret)$`)

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// MaskSQL replaces string/number literals with `?` (keeps structure, drops data).
func MaskSQL(sql string) string {
	var out strings.Builder
	n := len(sql)
	i := 0
	for i < n {
		c := sql[i]
		switch {
		case c == '\'':
			i++
			for i < n {
				if sql[i] == '\'' && i+1 < n && sql[i+1] == '\'' {
					i += 2
				} else if sql[i] == '\'' {
					i++
					break
				} else {
					i++
				}
			}
			out.WriteByte('?')
		case isDigit(c) && !prevIsWord(sql, i):
			j := i + 1
			for j < n && (isDigit(sql[j]) || sql[j] == '.' || sql[j] == 'e' || sql[j] == 'E') {
				j++
			}
			out.WriteByte('?')
			i = j
		default:
			out.WriteByte(c)
			i++
		}
	}
	return out.String()
}

func prevIsWord(s string, i int) bool {
	if i == 0 {
		return false
	}
	p := s[i-1]
	return p >= 'A' && p <= 'Z' || p >= 'a' && p <= 'z' || isDigit(p) || p == '_' || p == '$' || p == '#' || p == '.'
}

var (
	reCard   = regexp.MustCompile(`\b(?:\d[ -]?){13,19}\b`)
	reEmail  = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	reBearer = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{10,}`)
	reJWT    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
)

// redactPhones replaces (?<!\d)(?:\+?84|0)(?:[ .-]?\d){9,10}(?!\d) — RE2 has no look-around, so this is hand matched.
func redactPhones(s string) string {
	var out strings.Builder
	i := 0
	n := len(s)
	for i < n {
		end := matchPhone(s, i)
		if end > i {
			out.WriteString("[REDACTED:phone]")
			i = end
			continue
		}
		out.WriteByte(s[i])
		i++
	}
	return out.String()
}

func matchPhone(s string, i int) int {
	if i > 0 && isDigit(s[i-1]) {
		return -1
	}
	prefixes := []string{"+84", "84", "0"}
	for _, p := range prefixes {
		if !strings.HasPrefix(s[i:], p) {
			continue
		}
		pos := i + len(p)
		var ends []int // end offset after k reps
		for k := 0; k < 10; k++ {
			q := pos
			if q < len(s) && (s[q] == ' ' || s[q] == '.' || s[q] == '-') && q+1 < len(s) && isDigit(s[q+1]) {
				q++
			}
			if q < len(s) && isDigit(s[q]) {
				pos = q + 1
				ends = append(ends, pos)
			} else {
				break
			}
		}
		for k := len(ends); k >= 9; k-- {
			e := ends[k-1]
			if e >= len(s) || !isDigit(s[e]) {
				return e
			}
		}
	}
	return -1
}

// RedactText masks card numbers, emails, phones, bearer tokens and JWTs. Best effort.
func RedactText(s string) string {
	s = reCard.ReplaceAllString(s, "[REDACTED:card]")
	s = reEmail.ReplaceAllString(s, "[REDACTED:email]")
	s = redactPhones(s)
	s = reBearer.ReplaceAllString(s, "Bearer [REDACTED]")
	s = reJWT.ReplaceAllString(s, "[REDACTED:jwt]")
	return s
}

// RedactObject walks decoded JSON (map[string]any, []any, string...) and redacts it. Depth > 8 collapses to "[DEPTH]".
func RedactObject(v any) any { return redactObject(v, 0) }

func redactObject(v any, depth int) any {
	if depth > 8 {
		return "[DEPTH]"
	}
	switch x := v.(type) {
	case string:
		return RedactText(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = redactObject(e, depth+1)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			if sensitiveKeys.MatchString(k) {
				out[k] = "[REDACTED]"
			} else {
				out[k] = redactObject(e, depth+1)
			}
		}
		return out
	}
	return v
}

// RedactSecrets masks only bearer tokens and JWTs (used on log values, where emails/phones are legitimate).
func RedactSecrets(s string) string {
	s = reBearer.ReplaceAllString(s, "Bearer [REDACTED]")
	return reJWT.ReplaceAllString(s, "[REDACTED:jwt]")
}

// IsSensitiveKey reports whether a field name must never be logged/stored in clear.
func IsSensitiveKey(k string) bool { return sensitiveKeys.MatchString(k) }

// auditKeep lists detail keys whose values are legitimate trace data (identities, file names, ids). Under them only secrets
// (bearer tokens, JWTs, sensitive-named sub-keys) are masked and control characters stripped; e-mail/phone/card masking is
// skipped, because the audit trail must say WHO did it and WHICH file.
var auditKeep = map[string]bool{"email": true, "filename": true, "requester": true, "approver": true, "uploader": true, "recipients": true,
	"decidedby": true, "onbehalfof": true, "useragent": true, "requestid": true, "sessionref": true, "sha256": true, "manifesthash": true,
	"clientip": true, "xforwardedfor": true, "ticketid": true, "code": true, "name": true, "actoremail": true, "entries": true, "path": true, "notified": true, "delegator": true, "delegate": true, "revokedby": true,
	"requestedby": true, "downloadedby": true, "changedby": true, "fromapprover": true, "toapprover": true, "onbehalfofuser": true}

func stripControl(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029 || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
			return -1
		}
		return r
	}, s)
}

// RedactAudit is RedactObject for audit detail: secrets are always masked; identity/file keys (auditKeep) keep their
// e-mail/phone-looking content.
func RedactAudit(v any) any { return redactAudit(v, 0, false) }

func redactAudit(v any, depth int, keep bool) any {
	if depth > 8 {
		return "[DEPTH]"
	}
	switch x := v.(type) {
	case string:
		if keep {
			return RedactSecrets(stripControl(x))
		}
		return RedactText(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = redactAudit(e, depth+1, keep)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			if sensitiveKeys.MatchString(k) {
				out[k] = "[REDACTED]"
			} else {
				out[k] = redactAudit(e, depth+1, keep || auditKeep[strings.ToLower(k)])
			}
		}
		return out
	}
	return v
}
