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
	"net/http"
	"net/http/httptest"
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
