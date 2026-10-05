// Package scan contains scan adapters. Production skips application AV scanning.
package scan

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Status string

const (
	Skipped     Status = "skipped"
	Clean       Status = "clean"
	Infected    Status = "infected"
	Unavailable Status = "unavailable"
)

type Result struct {
	Status    Status
	Signature string // infected
	Reason    string // unavailable
}

type Scanner interface {
	// Scan consumes the plaintext stream.
	Scan(ctx context.Context, r io.Reader) Result
}

// DisabledScanner records that AV is handled outside the application. Draining
// the stream still verifies that the encrypted upload can be read in full.
type DisabledScanner struct{}

func (DisabledScanner) Scan(_ context.Context, r io.Reader) Result {
	if _, err := io.Copy(io.Discard, r); err != nil {
		return Result{Status: Unavailable, Reason: err.Error()}
	}
	return Result{Status: Skipped, Reason: "av_disabled"}
}

func (DisabledScanner) Name() string { return "av-disabled" }

// Unavailable is used when no scanner is configured: tickets stay SCANNING until one is.
type UnavailableScanner struct{}

func (UnavailableScanner) Scan(context.Context, io.Reader) Result {
	return Result{Status: Unavailable, Reason: "no malware scanner configured"}
}

// CleanScanner is a test adapter that drains the stream and reports clean.
type CleanScanner struct{}

func (CleanScanner) Scan(_ context.Context, r io.Reader) Result {
	if _, err := io.Copy(io.Discard, r); err != nil {
		return Result{Status: Unavailable, Reason: err.Error()}
	}
	return Result{Status: Clean}
}

// Clamd speaks the clamd INSTREAM protocol. NOTE: clamd rejects streams above StreamMaxLength (default 25 MB).
type Clamd struct {
	Host    string
	Port    int
	Timeout time.Duration
}

func NewClamd(host string, port int) *Clamd {
	return &Clamd{Host: host, Port: port, Timeout: 120 * time.Second}
}

var (
	okRe    = regexp.MustCompile(`OK$`)
	foundRe = regexp.MustCompile(`FOUND$`)
	streamP = regexp.MustCompile(`^stream:\s*`)
	foundS  = regexp.MustCompile(`\s*FOUND$`)
)

func (c *Clamd) Scan(ctx context.Context, r io.Reader) Result {
	to := c.Timeout
	if to == 0 {
		to = 120 * time.Second
	}
	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if err != nil {
		return Result{Status: Unavailable, Reason: "clamd: " + err.Error()}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(to))

	var werr error
	if _, werr = conn.Write([]byte("zINSTREAM\x00")); werr == nil {
		buf := make([]byte, 65536+4)
		for {
			n, rerr := r.Read(buf[4:])
			if n > 0 {
				binary.BigEndian.PutUint32(buf[:4], uint32(n))
				if _, werr = conn.Write(buf[:4+n]); werr != nil {
					break
				}
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				return Result{Status: Unavailable, Reason: rerr.Error()}
			}
		}
		if werr == nil {
			_, werr = conn.Write([]byte{0, 0, 0, 0}) // zero-length chunk terminates the stream
		}
	}
	// read the reply (NUL terminated, or until close). Even after a write error clamd may have said why.
	var out bytes.Buffer
	tmp := make([]byte, 512)
	for {
		n, err := conn.Read(tmp)
		out.Write(tmp[:n])
		if bytes.IndexByte(tmp[:n], 0) >= 0 || err != nil {
			break
		}
	}
	line := strings.TrimSpace(strings.ReplaceAll(out.String(), "\x00", ""))
	return clamdReply(line, werr)
}

func clamdReply(line string, werr error) Result {
	switch {
	case werr == nil && okRe.MatchString(line):
		return Result{Status: Clean}
	case foundRe.MatchString(line):
		signature := foundS.ReplaceAllString(streamP.ReplaceAllString(line, ""), "")
		if signature == "Heuristics.Encrypted.Zip" {
			return Result{Status: Skipped, Reason: "encrypted_zip"}
		}
		if strings.HasPrefix(signature, "Heuristics.Limits.Exceeded") || strings.HasPrefix(signature, "Heuristics.Encrypted") {
			return Result{Status: Unavailable, Reason: "clamd could not fully inspect file (scan limit or encryption)"}
		}
		return Result{Status: Infected, Signature: signature}
	case werr != nil && line == "":
		return Result{Status: Unavailable, Reason: "clamd: " + werr.Error()}
	}
	if line == "" {
		line = "no response"
	}
	return Result{Status: Unavailable, Reason: fmt.Sprintf("clamd: %s", line)}
}

// Named lets a scanner report its engine for the audit trail.
type Named interface{ Name() string }

func (UnavailableScanner) Name() string { return "none" }
func (CleanScanner) Name() string       { return "dev-clean" }
func (c *Clamd) Name() string           { return "clamd" }

// EngineName is the scanner's engine label ("unknown" for adapters that do not say).
func EngineName(s Scanner) string {
	if n, ok := s.(Named); ok {
		return n.Name()
	}
	return "unknown"
}
