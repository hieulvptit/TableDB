package shared

import (
	"fmt"
	"strings"
	"testing"
)

func TestCountSensitive(t *testing.T) {
	cases := []struct {
		in   string
		want SensitiveCounts
	}{
		{"hello world", SensitiveCounts{}},
		{"call 0912345678 now", SensitiveCounts{Phone: 1}},
		{"+84 912 345 678 and 0987-654-321", SensitiveCounts{Phone: 2}},
		{"mail a@b.vn, c.d@e-f.com", SensitiveCounts{Email: 2}},
		{"cmnd 123456789 cccd 012345678901", SensitiveCounts{IDNumber: 2}},
		{"card 4111 1111 1111 1111 ok", SensitiveCounts{Card: 1}},
		{"card 4111111111111112 bad luhn", SensitiveCounts{}},
		{"order 1234567 total 99", SensitiveCounts{}},
		{"id 1234567890123456789012", SensitiveCounts{}},
	}
	for _, c := range cases {
		if got := CountSensitive([]byte(c.in)); got != c.want {
			t.Errorf("%q: got %+v want %+v", c.in, got, c.want)
		}
	}
}

func TestRedactAuditKeepsIdentityButMasksSecrets(t *testing.T) {
	in := map[string]any{
		"requester":  map[string]any{"id": "u1", "email": "alice@vnpay.vn", "name": "Alice"},
		"recipients": []any{"bob@vnpay.vn", "carol@vnpay.vn"},
		"fileName":   "0912345678-report\r\n.csv",
		"userAgent":  "Mozilla/5.0 (Windows NT 10.0)",
		"reason":     "call me 0912345678 or mail x@y.vn; Bearer abcdefghijklmnop123456",
		"token":      "must-not-appear",
		"nested":     map[string]any{"password": "p", "note": "card 4111 1111 1111 1111"},
		"headers":    map[string]any{"cookie": "sid=abc", "authorization": "Bearer abcdefghijklmnop123456"},
		"requestId":  "0123456789abcdef",
	}
	out := RedactAudit(in).(map[string]any)
	s := fmt.Sprint(out)
	for _, leak := range []string{"must-not-appear", "abcdefghijklmnop123456", "sid=abc", "4111 1111", "x@y.vn"} {
		if strings.Contains(s, leak) {
			t.Errorf("%q leaked: %s", leak, s)
		}
	}
	if out["requester"].(map[string]any)["email"] != "alice@vnpay.vn" {
		t.Errorf("identity e-mail must be kept: %v", out["requester"])
	}
	if out["recipients"].([]any)[0] != "bob@vnpay.vn" {
		t.Errorf("recipients kept: %v", out["recipients"])
	}
	if out["fileName"] != "0912345678-report.csv" {
		t.Errorf("file name keeps digits but loses CR/LF: %q", out["fileName"])
	}
	if out["requestId"] != "0123456789abcdef" {
		t.Errorf("request id must not be phone-masked: %v", out["requestId"])
	}
	if !strings.Contains(out["reason"].(string), "[REDACTED:phone]") || !strings.Contains(out["reason"].(string), "[REDACTED:email]") {
		t.Errorf("free text is still masked: %v", out["reason"])
	}
	if out["token"] != "[REDACTED]" || out["nested"].(map[string]any)["password"] != "[REDACTED]" {
		t.Errorf("sensitive keys: %v", out)
	}
}
