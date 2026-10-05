package shared

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// The Node implementation measures and slices strings in UTF-16 code units (String.length / slice). The agent's budgets,
// truncation limits and audit numbers use the same units here so behaviour matches.

// U16Len is the JavaScript .length of s.
func U16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// U16Prefix is s.slice(0, n) (a split surrogate pair is dropped rather than emitted broken).
func U16Prefix(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n { // bytes >= UTF-16 units
		return s
	}
	if U16Len(s) <= n {
		return s
	}
	u := utf16.Encode([]rune(s))
	u = u[:n]
	if len(u) > 0 && u[len(u)-1] >= 0xD800 && u[len(u)-1] < 0xDC00 {
		u = u[:len(u)-1]
	}
	return string(utf16.Decode(u))
}

// U16Slice is s.slice(start, end) for 0 <= start <= end.
func U16Slice(s string, start, end int) string {
	if start <= 0 {
		return U16Prefix(s, end)
	}
	u := utf16.Encode([]rune(s))
	if end > len(u) {
		end = len(u)
	}
	if start >= end {
		return ""
	}
	u = u[start:end]
	if len(u) > 0 && u[len(u)-1] >= 0xD800 && u[len(u)-1] < 0xDC00 {
		u = u[:len(u)-1]
	}
	if len(u) > 0 && u[0] >= 0xDC00 && u[0] < 0xE000 {
		u = u[1:]
	}
	return string(utf16.Decode(u))
}

// IsJSSpace reports whether r matches JavaScript's \s.
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// CollapseSpaces is s.replace(/\s+/g, ' ').trim().
func CollapseSpaces(s string) string {
	var b strings.Builder
	pending := false
	for _, r := range s {
		if IsJSSpace(r) {
			pending = b.Len() > 0
			continue
		}
		if pending {
			b.WriteByte(' ')
			pending = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// JSString is String(v) for a JSON-decoded value.
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return x.String()
		}
		return jsNum(f)
	case float64:
		return jsNum(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = JSString(e)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

func jsNum(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == 0 {
		return "0"
	}
	a := math.Abs(f)
	if a >= 1e21 || a < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go prints e+21 / e-07; JS prints e+21 / e-7
		if i := strings.IndexAny(s, "e"); i >= 0 {
			exp := s[i+2:]
			exp = strings.TrimLeft(exp, "0")
			if exp == "" {
				exp = "0"
			}
			s = s[:i+2] + exp
		}
		return s
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// IsURL approximates zod's .url(): `new URL(s)` must succeed (scheme required; http(s) needs a host).
func IsURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || !utf8.ValidString(s) {
		return false
	}
	if (u.Scheme == "http" || u.Scheme == "https") && u.Host == "" {
		return false
	}
	return true
}
