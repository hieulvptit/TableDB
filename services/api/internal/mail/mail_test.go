package mail

import (
	"context"
	"net"
	"regexp"
	"strings"
	"sync"
	"testing"

	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/shared"
)

type fakeSMTP struct {
	ln   net.Listener
	mu   sync.Mutex
	data []string
}

func startFakeSMTP(t *testing.T) *fakeSMTP {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSMTP{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakeSMTP) serve(c net.Conn) {
	defer c.Close()
	_, _ = c.Write([]byte("220 test ESMTP\r\n"))
	inData := false
	buf := ""
	tmp := make([]byte, 4096)
	for {
		n, err := c.Read(tmp)
		if n > 0 {
			buf += string(tmp[:n])
		}
		for {
			i := strings.Index(buf, "\r\n")
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+2:]
			if inData {
				if line == "." {
					inData = false
					_, _ = c.Write([]byte("250 queued\r\n"))
				} else {
					f.mu.Lock()
					f.data = append(f.data, line)
					f.mu.Unlock()
				}
				continue
			}
			up := strings.ToUpper(line)
			switch {
			case strings.HasPrefix(up, "EHLO"):
				_, _ = c.Write([]byte("250-test\r\n250 8BITMIME\r\n"))
			case strings.HasPrefix(up, "DATA"):
				inData = true
				_, _ = c.Write([]byte("354 go\r\n"))
			case strings.HasPrefix(up, "QUIT"):
				_, _ = c.Write([]byte("221 bye\r\n"))
				return
			default:
				_, _ = c.Write([]byte("250 ok\r\n"))
			}
		}
		if err != nil {
			return
		}
	}
}

func (f *fakeSMTP) port() int { return f.ln.Addr().(*net.TCPAddr).Port }
func (f *fakeSMTP) wire() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.data, "\n")
}

var inj = Mail{To: []string{"lead@vnpay.vn"}, Subject: "Hi\r\nBcc: evil@x.com", Text: "body", HTML: "<p>body</p>"}

func TestNotConfiguredFailsLoudly(t *testing.T) {
	m := New(config.SMTP{Port: 587, TLS: "none"})
	if _, ok := m.(NotConfigured); !ok {
		t.Fatalf("%T", m)
	}
	if err := m.Send(context.Background(), inj); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("%v", err)
	}
}

func TestSMTPSendStripsCRLFFromSubject(t *testing.T) {
	smtp := startFakeSMTP(t)
	m := New(config.SMTP{Host: "127.0.0.1", Port: smtp.port(), TLS: "none", From: "noreply@vnpay.vn"})
	if err := m.Send(context.Background(), inj); err != nil {
		t.Fatal(err)
	}
	wire := smtp.wire()
	if !strings.Contains(wire, "Subject: Hi Bcc: evil@x.com") {
		t.Fatalf("subject header missing/unsafe:\n%s", wire)
	}
	if regexp.MustCompile(`(?m)^Bcc:`).MatchString(wire) {
		t.Fatalf("header injection:\n%s", wire)
	}
	if !strings.Contains(wire, "To: <lead@vnpay.vn>") && !strings.Contains(wire, "To: lead@vnpay.vn") {
		t.Fatalf("To header:\n%s", wire)
	}
}

func TestSMTPUnreachableIsUpstreamError(t *testing.T) {
	m := New(config.SMTP{Host: "127.0.0.1", Port: 1, TLS: "none", From: "a@b.c"})
	if err := m.Send(context.Background(), inj); err == nil || !strings.Contains(err.Error(), "SMTP send failed") {
		t.Fatalf("%v", err)
	}
}

func TestSMTPStarttlsIsRequired(t *testing.T) {
	smtp := startFakeSMTP(t) // does not advertise STARTTLS
	m := New(config.SMTP{Host: "127.0.0.1", Port: smtp.port(), TLS: "starttls", From: "noreply@vnpay.vn"})
	if err := m.Send(context.Background(), inj); err == nil {
		t.Fatal("starttls mode must refuse to send in clear when the server cannot upgrade")
	}
	if smtp.wire() != "" {
		t.Fatalf("mail body went out unencrypted:\n%s", smtp.wire())
	}
}

func TestTemplates(t *testing.T) {
	d := TicketMailData{Code: "TF-2026-000001", FileName: "a&b'c <x>.zip\r\nBcc: z", Size: 2500, SHA256: strings.Repeat("a", 64), Purpose: "mục đích\nxuống dòng",
		Direction: shared.OfficeToJump, Requester: Person{"Alice\r\nX", "a@vnpay.vn"}, Approver: Person{"Lead", "l@vnpay.vn"}, Link: "https://bo/x?a=1&b=2"}
	for name, m := range map[string]Mail{
		"approval":   ApprovalRequestMail(d, []string{"l@vnpay.vn"}),
		"approved":   DecisionMail(d, []string{"a@vnpay.vn"}, true),
		"rejected":   DecisionMail(d, []string{"a@vnpay.vn"}, false),
		"quarantine": QuarantineMail(d, []string{"a@vnpay.vn"}),
	} {
		if strings.ContainsAny(m.Subject, "\r\n") {
			t.Errorf("%s: CR/LF in subject %q", name, m.Subject)
		}
		if strings.Contains(m.HTML, "<x>") || strings.Contains(m.HTML, "a&b'c") {
			t.Errorf("%s: unescaped HTML", name)
		}
		if !strings.Contains(m.HTML, "https://bo/x?a=1&amp;b=2") {
			t.Errorf("%s: link not escaped", name)
		}
	}
	if !strings.Contains(DecisionMail(d, nil, true).Text, "máy jump") {
		t.Error("OFFICE_TO_JUMP approval should point to the jump app")
	}
	if fmtSize(2500) != "3 KB" || fmtSize(5<<20) != "5.0 MB" || fmtSize(3<<30) != "3.00 GB" {
		t.Errorf("fmtSize: %s %s %s", fmtSize(2500), fmtSize(5<<20), fmtSize(3<<30))
	}
}

func TestApprovalEmailUsesSingleUseLinkAndRetainsDetails(t *testing.T) {
	d := TicketMailData{Code: "TF-1", FileName: "data.csv", Direction: shared.JumpToOffice, Link: "https://bo.example/transfers/123", ApprovalLink: "https://bo.example/api/v1/email-approval#test-secret"}
	m := ApprovalRequestMail(d, []string{"lead@vnpay.vn"})
	if !strings.Contains(m.HTML, `class="action" href="https://bo.example/api/v1/email-approval#test-secret"`) || !strings.Contains(m.HTML, "Duyệt yêu cầu") || !strings.Contains(m.Text, d.ApprovalLink) {
		t.Fatal("primary action is not the direct approval link")
	}
	if !strings.Contains(m.HTML, d.Link) || !strings.Contains(m.Text, d.Link) {
		t.Fatal("BO detail link missing")
	}
	if !strings.Contains(m.HTML, "phê duyệt ngay") || !strings.Contains(m.HTML, "Không chuyển tiếp") {
		t.Fatal("approval link behavior missing")
	}
	if strings.Contains(DecisionMail(d, nil, true).HTML, "test-secret") {
		t.Fatal("approval capability leaked to decision notification")
	}
}
