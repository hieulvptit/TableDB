package securetransport

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func privateKey(t *testing.T) string {
	t.Helper()
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	b := make([]byte, 32)
	k.D.FillBytes(b)
	return base64.StdEncoding.EncodeToString(b)
}
func fixture(t *testing.T) (*Transport, *session) {
	t.Helper()
	transport, e := New(Settings{SigningKey: privateKey(t), WebSigningKey: privateKey(t), Required: true, TTL: time.Minute, MaxSessions: 2})
	if e != nil {
		t.Fatal(e)
	}
	b, _ := aes.NewCipher(make([]byte, 32))
	a, _ := cipher.NewGCM(b)
	s := &session{kind: "desktop", id: "test", expires: time.Now().Add(time.Minute), send: a, receive: a, seen: map[uint64]bool{}}
	transport.sessions[s.id] = s
	return transport, s
}
func request(t *testing.T, s *session, seq uint64, final bool) *http.Request {
	t.Helper()
	var body bytes.Buffer
	index := uint32(0)
	m, _ := json.Marshal(requestMeta{Method: "POST", Path: "/api/v1/mutate"})
	if e := writeRecord(&body, s.receive, s.id, "c2s", seq, &index, 1, m); e != nil {
		t.Fatal(e)
	}
	if final {
		writeRecord(&body, s.receive, s.id, "c2s", seq, &index, 3, nil)
	}
	r := httptest.NewRequest("POST", requestPath, &body)
	r.Header.Set("Content-Type", ContentType)
	r.Header.Set("X-TableDB-Session", s.id)
	r.Header.Set("X-TableDB-Sequence", "1")
	return r
}
func TestValidateFinalBeforeMutationAndReplay(t *testing.T) {
	tr, s := fixture(t)
	calls := 0
	handler := tr.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, request(t, s, 1, false))
	if calls != 0 || w.Code != 400 {
		t.Fatal("truncated request executed")
	}
	tr, s = fixture(t)
	handler = tr.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	r := request(t, s, 1, true)
	wire, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(wire))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if calls != 1 || w.Code != 200 {
		t.Fatal("valid request failed")
	}
	r = request(t, s, 1, true)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 409 || calls != 1 {
		t.Fatal("replayed request executed")
	}
}
func TestExpiredSession(t *testing.T) {
	tr, s := fixture(t)
	s.expires = time.Now().Add(-time.Second)
	w := httptest.NewRecorder()
	tr.Wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("expired session dispatched") })).ServeHTTP(w, request(t, s, 1, true))
	if w.Code != 410 {
		t.Fatal(w.Code)
	}
}
func TestSeparateSigningIdentities(t *testing.T) {
	key := privateKey(t)
	if _, e := New(Settings{SigningKey: key, WebSigningKey: key, TTL: time.Minute, MaxSessions: 2}); e == nil {
		t.Fatal("same web and desktop key accepted")
	}
}
func TestReplayWindow(t *testing.T) {
	s := &session{seen: map[uint64]bool{}}
	for _, n := range []uint64{3, 1, 2, 130} {
		if !s.accept(n) {
			t.Fatal(n)
		}
	}
	for _, n := range []uint64{0, 1, 2, 3, 130, 1 << 49} {
		if s.accept(n) {
			t.Fatal("accepted replay/invalid sequence", n)
		}
	}
	if !s.accept(129) {
		t.Fatal("valid reordered sequence")
	}
}
func TestPlaintextExceptions(t *testing.T) {
	tr, _ := fixture(t)
	handler := tr.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, p := range []string{"/api/v1/auth/login", "/api/v1/auth/callback", "/api/v1/email-approval", "/healthz"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		if w.Code != 204 {
			t.Fatal(p, w.Code)
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/transfers", nil))
	if w.Code != 426 {
		t.Fatal(w.Code)
	}
}

func TestMissingDownloadBytesHasNoTerminal(t *testing.T) {
	_, s := fixture(t)
	outer := httptest.NewRecorder()
	writer := &secureWriter{outer: outer, session: s, seq: 1, headers: make(http.Header)}
	writer.Header().Set("Content-Length", "3")
	writer.Write([]byte("x"))
	writer.finish()
	reader := &records{reader: outer.Body, key: s.send, id: s.id, dir: "s2c", seq: 1}
	if kind, _, e := reader.record(); e != nil || kind != 1 {
		t.Fatal("metadata missing")
	}
	if _, e := io.ReadAll(reader); e == nil {
		t.Fatal("short download was authenticated as complete")
	}
}
func TestHandshakeRateBounded(t *testing.T) {
	tr, _ := fixture(t)
	tr.cfg.HandshakesPerMinute = 1
	req := func() *http.Request { return httptest.NewRequest("POST", handshakePath, bytes.NewBufferString(`{}`)) }
	handler := tr.Wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("handshake dispatched") }))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req())
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req())
	if w.Code != 429 {
		t.Fatal(w.Code)
	}
	tr.now = func() time.Time { return time.Now().Add(time.Minute) }
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req())
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestRequestAdmissionBounded(t *testing.T) {
	tr, s := fixture(t)
	for i := 0; i < cap(tr.slots); i++ {
		tr.slots <- struct{}{}
	}
	w := httptest.NewRecorder()
	tr.Wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("admission limit bypassed") })).ServeHTTP(w, request(t, s, 1, true))
	if w.Code != 429 {
		t.Fatal(w.Code)
	}
}

func TestRejectionDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		modify       func(*testing.T, *session, *http.Request)
	}{
		{"content type", "invalid_content_type", func(_ *testing.T, _ *session, r *http.Request) {
			r.Header.Set("Content-Type", "application/octet-stream")
		}},
		{"metadata record", "frame_prefix_read_failed", func(_ *testing.T, _ *session, r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader("bad"))
		}},
		{"truncated ciphertext", "frame_ciphertext_read_failed", func(t *testing.T, _ *session, r *http.Request) {
			wire, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatal(err)
			}
			r.Body = io.NopCloser(bytes.NewReader(wire[:5]))
		}},
		{"tampered ciphertext", "frame_authentication_failed", func(t *testing.T, _ *session, r *http.Request) {
			wire, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatal(err)
			}
			wire[4] ^= 1
			r.Body = io.NopCloser(bytes.NewReader(wire))
		}},
		{"proxy prefix in encrypted path", "invalid_api_path", func(t *testing.T, s *session, r *http.Request) {
			var body bytes.Buffer
			index := uint32(0)
			meta, _ := json.Marshal(requestMeta{Method: "POST", Path: "/c/api/v1/mutate?token=private-query", Headers: map[string]string{"authorization": "Bearer private-token"}})
			if err := writeRecord(&body, s.receive, s.id, "c2s", 1, &index, 1, meta); err != nil {
				t.Fatal(err)
			}
			r.Body = io.NopCloser(&body)
		}},
		{"missing terminal record", "frame_prefix_read_failed", func(t *testing.T, s *session, r *http.Request) {
			r.Body = request(t, s, 1, false).Body
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr, s := fixture(t)
			var logs bytes.Buffer
			tr.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
			r := request(t, s, 1, true)
			tc.modify(t, s, r)
			w := httptest.NewRecorder()
			w.Header().Set("X-Request-ID", "test-request-id")
			tr.Wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("rejected request dispatched") })).ServeHTTP(w, r)
			if w.Code != 400 {
				t.Fatalf("status = %d", w.Code)
			}
			var entry map[string]any
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if entry["reason"] != tc.reason || entry["request_id"] != "test-request-id" || entry["status"] != float64(400) || entry["code"] == "" {
				t.Fatalf("unexpected diagnostics: %v", entry)
			}
			for _, secret := range []string{"private-query", "private-token", "/c/api/v1/mutate"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatal("diagnostics disclosed request data")
				}
			}
			var response struct {
				Error struct{ Code, Message string }
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Error.Code != entry["code"] || response.Error.Message != "secure transport rejected request" {
				t.Fatal("public error response changed")
			}
		})
	}
}

func TestSecureAPILogReportsInnerStatusAndRoute(t *testing.T) {
	tr, s := fixture(t)
	var logs bytes.Buffer
	tr.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/mutate", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) })
	w := httptest.NewRecorder()
	w.Header().Set("X-Request-ID", "inner-status-id")
	tr.Wrap(mux).ServeHTTP(w, request(t, s, 1, true))
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || entry["status"] != float64(403) || entry["route"] != "POST /api/v1/mutate" || entry["request_id"] != "inner-status-id" || entry["level"] != "WARN" {
		t.Fatalf("inner failure hidden by outer response: status=%d; log=%v", w.Code, entry)
	}
}
