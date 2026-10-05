package scan

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
)

type fakeClamd struct {
	ln       net.Listener
	mu       sync.Mutex
	received []byte
}

func startFakeClamd(t *testing.T, reply string) *fakeClamd {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeClamd{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 4096)
				for {
					n, err := c.Read(buf)
					f.mu.Lock()
					f.received = append(f.received, buf[:n]...)
					done := len(f.received) >= 4 && bytes.HasSuffix(f.received, []byte{0, 0, 0, 0})
					f.mu.Unlock()
					if done {
						_, _ = c.Write([]byte(reply + "\x00"))
						return
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakeClamd) port() int { return f.ln.Addr().(*net.TCPAddr).Port }
func (f *fakeClamd) wire() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.received...)
}

func TestClamdFramingAndReplies(t *testing.T) {
	ok := startFakeClamd(t, "stream: OK")
	got := (&Clamd{Host: "127.0.0.1", Port: ok.port()}).Scan(context.Background(), strings.NewReader("hello"))
	if got.Status != Clean {
		t.Fatalf("%+v", got)
	}
	w := ok.wire()
	if string(w[:10]) != "zINSTREAM\x00" || binary.BigEndian.Uint32(w[10:14]) != 5 || string(w[14:19]) != "hello" || !bytes.Equal(w[len(w)-4:], []byte{0, 0, 0, 0}) {
		t.Fatalf("wire format: %q", w)
	}

	bad := startFakeClamd(t, "stream: Eicar-Test-Signature FOUND")
	r := (&Clamd{Host: "127.0.0.1", Port: bad.port()}).Scan(context.Background(), strings.NewReader("x"))
	if r.Status != Infected || r.Signature != "Eicar-Test-Signature" {
		t.Fatalf("%+v", r)
	}

	er := startFakeClamd(t, "INSTREAM size limit exceeded. ERROR")
	if r := (&Clamd{Host: "127.0.0.1", Port: er.port()}).Scan(context.Background(), strings.NewReader("x")); r.Status != Unavailable {
		t.Fatalf("%+v", r)
	}
}

func TestClamdLargeStreamIsChunked(t *testing.T) {
	f := startFakeClamd(t, "stream: OK")
	big := bytes.Repeat([]byte("a"), 200_000)
	if r := (&Clamd{Host: "127.0.0.1", Port: f.port()}).Scan(context.Background(), bytes.NewReader(big)); r.Status != Clean {
		t.Fatalf("%+v", r)
	}
	w := f.wire()[10:]
	total := 0
	for len(w) >= 4 {
		n := int(binary.BigEndian.Uint32(w[:4]))
		if n == 0 {
			break
		}
		if n > 65536 {
			t.Fatalf("chunk of %d bytes exceeds 64 KiB", n)
		}
		total += n
		w = w[4+n:]
	}
	if total != len(big) {
		t.Fatalf("streamed %d bytes, want %d", total, len(big))
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestUnavailableIsNeverClean(t *testing.T) {
	if r := (&Clamd{Host: "127.0.0.1", Port: 1}).Scan(context.Background(), strings.NewReader("x")); r.Status != Unavailable {
		t.Fatalf("unreachable clamd: %+v", r)
	}
	if r := (UnavailableScanner{}).Scan(context.Background(), strings.NewReader("x")); r.Status != Unavailable {
		t.Fatalf("no scanner: %+v", r)
	}
	f := startFakeClamd(t, "stream: OK")
	if r := (&Clamd{Host: "127.0.0.1", Port: f.port()}).Scan(context.Background(), errReader{}); r.Status == Clean {
		t.Fatal("a read error must never be reported clean")
	}
	if r := (CleanScanner{}).Scan(context.Background(), errReader{}); r.Status == Clean {
		t.Fatal("dev scanner must not report clean on read errors")
	}
}

func TestDisabledScannerDoesNotReportCleanOrHideReadErrors(t *testing.T) {
	s := DisabledScanner{}
	if r := s.Scan(context.Background(), strings.NewReader("content")); r.Status != Skipped || r.Reason != "av_disabled" {
		t.Fatalf("disabled: %+v", r)
	}
	if r := s.Scan(context.Background(), errReader{}); r.Status != Unavailable {
		t.Fatalf("read error: %+v", r)
	}
}
