package pii

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/httpx"
)

type fakeSender struct {
	send func(*http.Request) (*http.Response, error)
}

func (f fakeSender) Do(_ context.Context, h httpx.Hop, r *http.Request, _ time.Duration) (*http.Response, context.CancelFunc, error) {
	if h != httpx.HopPII {
		panic("wrong proxy hop")
	}
	resp, err := f.send(r)
	return resp, func() {}, err
}
func settings() config.PII {
	return config.PII{URL: "https://genai.example/chat/completions", APIKey: "service-token", Model: "v_kimi", MaxFileBytes: 1024, MaxTextBytes: 1024, ChunkChars: 128, TimeoutSec: 5, SampleLines: 20}
}
func response(content string) *http.Response {
	b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(b))}
}
func TestLLMScansAllChunksAndReturnsOnlyCategories(t *testing.T) {
	seen := []string{}
	l := LLM{Config: settings(), Out: fakeSender{func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer service-token" {
			t.Fatal("missing service authentication")
		}
		var body struct {
			Messages []struct{ Role, Content string }
			Model    string
			Stream   bool
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Messages) != 2 || body.Messages[0].Role != "system" || body.Messages[1].Role != "user" || body.Model != "v_kimi" || body.Stream {
			t.Fatal("incorrect classifier request")
		}
		seen = append(seen, body.Messages[1].Content)
		if strings.Contains(body.Messages[1].Content, "test@vnpay.vn") {
			return response(`{"detected":true,"categories":["email"]}`), nil
		}
		return response(`{"detected":false,"categories":[]}`), nil
	}}}
	text := strings.Repeat("a", 120) + "test@vnpay.vn" + strings.Repeat("b", 150)
	report, err := l.Scan(context.Background(), "data.txt", strings.NewReader(text))
	if err != nil || !report.Detected || report.Chunks < 2 || strings.Join(report.Categories, ",") != "email" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	if !strings.HasSuffix(seen[len(seen)-1], strings.Repeat("b", 20)) {
		t.Fatal("last part not scanned")
	}
	b, _ := json.Marshal(report.Metadata())
	if strings.Contains(string(b), "test@") {
		t.Fatal("PII values leaked")
	}
}
func TestInvalidVerdictsNeverBecomeClean(t *testing.T) {
	for _, content := range []string{`{}`, `{"detected":false}`, `{"detected":false,"categories":["email"]}`, `{"detected":true,"categories":["test@vnpay.vn"]}`, `{"detected":true,"categories":["email"],"excerpt":"secret"}`, `{"detected":false,"categories":[]} trailing`} {
		l := LLM{Config: settings(), Out: fakeSender{func(*http.Request) (*http.Response, error) { return response(content), nil }}}
		if _, err := l.Scan(context.Background(), "x.txt", strings.NewReader("x")); err == nil {
			t.Fatalf("accepted invalid verdict %s", content)
		}
	}
}
func TestUnsupportedOversizedAndInvalidTextFailBeforeLLM(t *testing.T) {
	l := LLM{Config: settings(), Out: fakeSender{func(*http.Request) (*http.Response, error) {
		t.Fatal("LLM called on incomplete extraction")
		return nil, nil
	}}}
	for _, tc := range []struct{ name, data string }{{"x.pdf", "%PDF"}, {"x.txt", strings.Repeat("a", 1<<20)}, {"x.txt", "a\x00b"}, {"x.txt", "\xff"}} {
		if _, err := l.Scan(context.Background(), tc.name, strings.NewReader(tc.data)); err == nil {
			t.Fatalf("accepted %s", tc.name)
		}
	}
	l.Config.APIKey = ""
	if _, err := l.Scan(context.Background(), "x.txt", strings.NewReader("x")); err == nil {
		t.Fatal("missing key accepted")
	}
}
func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for name, content := range files {
		r, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(r, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestExtractionChecksWholeArchiveAndOfficeText(t *testing.T) {
	zipBytes := makeZip(t, map[string]string{"a.txt": "hello", "b.csv": "a,b\nx,y"})
	cfg := settings()
	cfg.MaxFileBytes = 4096
	cfg.MaxTextBytes = 4096
	sample, err := sampleFile(context.Background(), "x.zip", bytes.NewReader(zipBytes), cfg)
	text := strings.Join(sample.Lines, "\n")
	if err != nil || !strings.Contains(text, "hello") || !strings.Contains(text, "x,y") {
		t.Fatalf("text=%q err=%v", text, err)
	}
	unsupported := makeZip(t, map[string]string{"a.txt": "hello", "hidden.bin": "binary"})
	if _, err := sampleFile(context.Background(), "x.zip", bytes.NewReader(unsupported), cfg); err == nil {
		t.Fatal("unsupported entry silently skipped")
	}
	if _, err := sampleFile(context.Background(), "x.zip", bytes.NewReader(zipBytes), config.PII{MaxFileBytes: 5, MaxTextBytes: 4096, SampleLines: 20}); err == nil {
		t.Fatal("archive budget silently truncated")
	}
	doc := makeZip(t, map[string]string{"word/document.xml": `<document><p>test@vnpay.vn</p></document>`, "_rels/.rels": `<Relationships/>`})
	sample, err = sampleFile(context.Background(), "x.docx", bytes.NewReader(doc), cfg)
	text = strings.Join(sample.Lines, "\n")
	if err != nil || !strings.Contains(text, "test@vnpay.vn") {
		t.Fatalf("Office text lost: %q %v", text, err)
	}
}

func TestHeaderAlwaysKeptAndBodySamplesReachEnd(t *testing.T) {
	s := &reservoir{limit: 3, choose: func(n int64) (int64, error) { return 0, nil }}
	if err := s.header("name,email"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if err := s.add(strings.Repeat("x", i+1)); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.result.Lines) != 3 || s.result.Lines[0] != "name,email" || s.result.Lines[1] != strings.Repeat("x", 100) || s.result.TotalLines != 101 {
		t.Fatalf("bad sample: %+v", s.result)
	}
	cfg := settings()
	sample, err := sampleFile(context.Background(), "x.csv", strings.NewReader("name,email\n"+strings.Repeat("a,b\n", 100)), cfg)
	if err != nil || sample.Lines[0] != "name,email" || len(sample.Lines) != 20 || sample.TotalLines != 101 {
		t.Fatalf("sample=%+v error=%v", sample, err)
	}
}
func TestEncryptedZipListsWithoutLLM(t *testing.T) {
	data := makeZip(t, map[string]string{"data.csv": "name,email\nx,x@example.com"})
	for _, sig := range [][]byte{[]byte("PK\x03\x04"), []byte("PK\x01\x02")} {
		i := bytes.Index(data, sig)
		offset := 6
		if sig[2] == 1 {
			offset = 8
		}
		data[i+offset] |= 1
	}
	cfg := settings()
	cfg.APIKey = ""
	l := LLM{Config: cfg, Out: fakeSender{func(*http.Request) (*http.Response, error) { t.Fatal("encrypted content sent to LLM"); return nil, nil }}}
	report, err := l.Scan(context.Background(), "secret.zip", bytes.NewReader(data))
	if err != nil || report.Coverage != "metadata_only" || report.ListedFiles != 1 || report.EncryptedFiles != 1 || report.Chunks != 0 || report.Detected {
		t.Fatalf("report=%+v error=%v", report, err)
	}
}
