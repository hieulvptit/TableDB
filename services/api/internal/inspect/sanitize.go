package inspect

import (
	"strings"
	"unicode"
)

// SanitizeName makes a user-controlled name safe to log, mail and render: invalid UTF-8 is replaced, control characters
// (CR/LF/NUL/…), bidi overrides and zero-width characters are dropped, and the length is capped (in runes).
func SanitizeName(s string, max int) string {
	if max <= 0 {
		max = 255
	}
	s = strings.ToValidUTF8(s, "?")
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || (r >= 0x200B && r <= 0x200F) || (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) || r == 0xFEFF || r == 0x2028 || r == 0x2029 {
			continue
		}
		if n >= max {
			b.WriteString("…")
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}
