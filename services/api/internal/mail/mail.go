// Package mail: Mailer adapters (SMTP, not-configured, dev log, test fake) and the notification templates.
package mail

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sync"
	"time"

	gomail "github.com/wneessen/go-mail"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/config"
)

type Mail struct {
	To      []string
	Subject string
	Text    string
	HTML    string
}

type Mailer interface {
	Send(ctx context.Context, m Mail) error
}

var crlf = regexp.MustCompile(`[\r\n]+`)

func noCRLF(s string) string { return crlf.ReplaceAllString(s, " ") }

// NotConfigured fails loudly (outbox retries, ticket.notify_state=ERROR). Never pretends a mail was sent.
type NotConfigured struct{}

func (NotConfigured) Send(context.Context, Mail) error {
	return apperr.NewUpstream("email is not configured (SMTP_HOST / MAIL_FROM). See docs/VNPAY-INPUTS.md §5")
}

// SMTP: starttls = upgrade and REQUIRE it (default); implicit = TLS from connect (465); none = plaintext (test/internal relay only).
type SMTP struct{ S config.SMTP }

func (m *SMTP) Send(ctx context.Context, mm Mail) error {
	if len(mm.To) == 0 {
		return nil
	}
	err := m.send(ctx, mm)
	if err != nil {
		msg := noCRLF(err.Error())
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return apperr.NewUpstream("SMTP send failed: " + msg)
	}
	return nil
}

func (m *SMTP) send(ctx context.Context, mm Mail) error {
	msg := gomail.NewMsg()
	if err := msg.From(m.S.From); err != nil {
		return err
	}
	if err := msg.To(mm.To...); err != nil {
		return err
	}
	msg.Subject(noCRLF(mm.Subject)) // header injection safe
	msg.SetBodyString(gomail.TypeTextPlain, mm.Text)
	msg.AddAlternativeString(gomail.TypeTextHTML, mm.HTML)

	opts := []gomail.Option{gomail.WithPort(m.S.Port), gomail.WithTimeout(30 * time.Second)}
	switch m.S.TLS {
	case "implicit":
		opts = append(opts, gomail.WithSSL())
	case "none":
		opts = append(opts, gomail.WithTLSPolicy(gomail.NoTLS))
	default:
		opts = append(opts, gomail.WithTLSPolicy(gomail.TLSMandatory))
	}
	if m.S.User != "" {
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthAutoDiscover), gomail.WithUsername(m.S.User), gomail.WithPassword(m.S.Pass))
	}
	c, err := gomail.NewClient(m.S.Host, opts...)
	if err != nil {
		return err
	}
	return c.DialAndSendWithContext(ctx, msg)
}

// New picks SMTP when host and from are set, otherwise NotConfigured.
func New(s config.SMTP) Mailer {
	if s.Host != "" && s.From != "" {
		return &SMTP{S: s}
	}
	return NotConfigured{}
}

// DevLog (DEV_LOG_MAIL) prints mails instead of sending them. Refused in prod by config validation.
type DevLog struct{}

func (DevLog) Send(_ context.Context, m Mail) error {
	fmt.Fprintf(os.Stdout, "\n[DEV MAIL] to=%v\nSubject: %s\n%s\n\n", m.To, m.Subject, m.Text)
	return nil
}

// Fake records mails for tests; FailNext makes the next n sends fail with an upstream error.
type Fake struct {
	mu       sync.Mutex
	sent     []Mail
	failNext int
}

func (f *Fake) SetFailNext(n int) { f.mu.Lock(); f.failNext = n; f.mu.Unlock() }

func (f *Fake) Send(_ context.Context, m Mail) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext > 0 {
		f.failNext--
		return apperr.NewUpstream("SMTP send failed: simulated")
	}
	f.sent = append(f.sent, m)
	return nil
}

func (f *Fake) All() []Mail {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Mail(nil), f.sent...)
}

// To returns the mails addressed to email.
func (f *Fake) To(email string) []Mail {
	var out []Mail
	for _, m := range f.All() {
		for _, t := range m.To {
			if t == email {
				out = append(out, m)
				break
			}
		}
	}
	return out
}
