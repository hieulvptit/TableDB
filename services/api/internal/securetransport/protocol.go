// Package securetransport implements the versioned desktop API record protocol.
// The pinned server signing key authenticates ephemeral P-256 key agreement;
// HKDF derives independent AES-256-GCM keys for each direction. This is an
// additional application transport, not a replacement for HTTPS.
package securetransport

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

const Version = "tabledb-aes-v1"
const FrameBytes = 64 * 1024
const ContentType = "application/vnd.tabledb.aesgcm"
const handshakePath = "/api/v1/secure/handshake"
const requestPath = "/api/v1/secure/request"

//go:embed browser-client.js
var browserClient []byte

func BrowserModule(w http.ResponseWriter, r *http.Request, pin string, enabled bool) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if !enabled {
		_, _ = io.WriteString(w, "export const serverPublicKey = ''; export function createSecureFetch(){return (...a)=>fetch(...a)}")
		return
	}
	encoded, _ := json.Marshal(pin)
	_, _ = fmt.Fprintf(w, "export const serverPublicKey = %s;\n", encoded)
	_, _ = w.Write(browserClient)
}

var errRecord = errors.New("invalid encrypted record")

type encryptedKey struct{}
type kindKey struct{}

func ClientKind(ctx context.Context) string { v, _ := ctx.Value(kindKey{}).(string); return v }

func IsEncrypted(ctx context.Context) bool { v, _ := ctx.Value(encryptedKey{}).(bool); return v }

type Settings struct {
	SigningKey          string
	WebSigningKey       string
	Required            bool
	TTL                 time.Duration
	MaxSessions         int
	MaxRequestBytes     int64
	MaxInFlight         int
	HandshakesPerMinute int
	ClientIP            func(*http.Request) string
}
type session struct {
	kind          string
	id            string
	expires       time.Time
	send, receive cipher.AEAD
	mu            sync.Mutex
	highest       uint64
	seen          map[uint64]bool
}

func (s *session) accept(n uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n == 0 || n > 1<<48 || s.seen[n] || s.highest >= 128 && n <= s.highest-128 {
		return false
	}
	if n > s.highest {
		s.highest = n
	}
	for old := range s.seen {
		if s.highest >= 128 && old <= s.highest-128 {
			delete(s.seen, old)
		}
	}
	s.seen[n] = true
	return true
}

type rateEntry struct {
	since time.Time
	count int
}
type Transport struct {
	slots      chan struct{}
	rates      map[string]rateEntry
	signing    *ecdsa.PrivateKey
	webSigning *ecdsa.PrivateKey
	cfg        Settings
	mu         sync.Mutex
	sessions   map[string]*session
	now        func() time.Time
}

func New(c Settings) (*Transport, error) {
	if c.MaxInFlight == 0 {
		c.MaxInFlight = 16
	}
	if c.HandshakesPerMinute == 0 {
		c.HandshakesPerMinute = 30
	}
	if c.MaxInFlight < 1 || c.MaxInFlight > 128 || c.HandshakesPerMinute < 1 || c.HandshakesPerMinute > 1000 {
		return nil, errors.New("invalid secure admission limits")
	}
	if c.MaxRequestBytes == 0 {
		c.MaxRequestBytes = 8 << 20
	}
	if c.MaxRequestBytes < 1 || c.MaxRequestBytes > 64<<20 {
		return nil, errors.New("invalid encrypted request limit")
	}
	key, err := base64.StdEncoding.DecodeString(c.SigningKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("SECURE_DESKTOP_SIGNING_KEY must be a base64 P-256 private scalar")
	}
	d := new(big.Int).SetBytes(key)
	if d.Sign() <= 0 || d.Cmp(elliptic.P256().Params().N) >= 0 {
		return nil, errors.New("invalid secure transport signing key")
	}
	x, y := elliptic.P256().ScalarBaseMult(key)
	if c.TTL < time.Minute || c.TTL > time.Hour || c.MaxSessions < 1 || c.MaxSessions > 4096 {
		return nil, errors.New("invalid secure transport session limits")
	}
	webConfig := c
	webConfig.SigningKey = c.WebSigningKey
	webConfig.WebSigningKey = ""
	var web *ecdsa.PrivateKey
	if c.WebSigningKey != "" {
		wt, err := New(webConfig)
		if err != nil {
			return nil, err
		}
		web = wt.signing
		if web.PublicKey.Equal(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}) {
			return nil, errors.New("web and desktop signing keys must differ")
		}
	}
	return &Transport{slots: make(chan struct{}, c.MaxInFlight), rates: map[string]rateEntry{}, webSigning: web, signing: &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: d}, cfg: c, sessions: map[string]*session{}, now: time.Now}, nil
}
func (t *Transport) PublicKey() string {
	return base64.StdEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), t.signing.X, t.signing.Y))
}

type hello struct {
	ClientKind string `json:"clientKind"`
	Version    string `json:"version"`
	PublicKey  string `json:"publicKey"`
	Nonce      string `json:"nonce"`
}
type welcome struct {
	Version   string `json:"version"`
	SessionID string `json:"sessionId"`
	PublicKey string `json:"publicKey"`
	Nonce     string `json:"nonce"`
	ExpiresAt int64  `json:"expiresAt"`
	Signature string `json:"signature"`
	Finished  string `json:"finished"`
}

func transcript(h hello, w welcome) string {
	return strings.Join([]string{Version, w.SessionID, h.ClientKind, h.PublicKey, w.PublicKey, h.Nonce, w.Nonce, strconv.FormatInt(w.ExpiresAt, 10)}, "|")
}
func derive(secret, salt []byte, label string) (cipher.AEAD, error) {
	k, err := hkdf.Key(sha256.New, secret, salt, Version+"|"+label, 32)
	if err != nil {
		return nil, err
	}
	b, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}
func nonce(sequence uint64, index uint32) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint64(n, sequence)
	binary.BigEndian.PutUint32(n[8:], index)
	return n
}
func aad(id string, sequence uint64, index uint32, direction string) []byte {
	return []byte(fmt.Sprintf("%s|%s|%d|%d|%s", Version, id, sequence, index, direction))
}
func failure(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": "secure transport rejected request"}})
}
func (t *Transport) handshake(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		failure(w, 405, "SECURE_METHOD")
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if t.cfg.ClientIP != nil {
		ip = t.cfg.ClientIP(r)
	}
	t.mu.Lock()
	nowRate := t.now()
	for p, e := range t.rates {
		if nowRate.Sub(e.since) >= time.Minute {
			delete(t.rates, p)
		}
	}
	e := t.rates[ip]
	if e.since.IsZero() {
		e.since = nowRate
	}
	if e.count >= t.cfg.HandshakesPerMinute || (e.count == 0 && len(t.rates) >= 8192) {
		t.mu.Unlock()
		failure(w, 429, "SECURE_RATE_LIMIT")
		return
	}
	e.count++
	t.rates[ip] = e
	t.mu.Unlock()
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Second))
	defer http.NewResponseController(w).SetReadDeadline(time.Time{})
	var h hello
	dec := json.NewDecoder(io.LimitReader(r.Body, 4097))
	dec.DisallowUnknownFields()
	if dec.Decode(&h) != nil || h.Version != Version || (h.ClientKind != "desktop" && h.ClientKind != "web") {
		failure(w, 400, "SECURE_HANDSHAKE")
		return
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		failure(w, 400, "SECURE_HANDSHAKE")
		return
	}
	pub, err := base64.StdEncoding.DecodeString(h.PublicKey)
	if err != nil {
		failure(w, 400, "SECURE_HANDSHAKE")
		return
	}
	client, err := ecdh.P256().NewPublicKey(pub)
	if err != nil {
		failure(w, 400, "SECURE_HANDSHAKE")
		return
	}
	challenge, err := base64.StdEncoding.DecodeString(h.Nonce)
	if err != nil || len(challenge) != 32 {
		failure(w, 400, "SECURE_HANDSHAKE")
		return
	}
	now := t.now()
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		failure(w, 500, "SECURE_HANDSHAKE")
		return
	}
	secret, err := ephemeral.ECDH(client)
	if err != nil {
		failure(w, 400, "SECURE_HANDSHAKE")
		return
	}
	id := make([]byte, 24)
	serverNonce := make([]byte, 32)
	if _, err = rand.Read(id); err != nil {
		failure(w, 500, "SECURE_HANDSHAKE")
		return
	}
	if _, err = rand.Read(serverNonce); err != nil {
		failure(w, 500, "SECURE_HANDSHAKE")
		return
	}
	out := welcome{Version: Version, SessionID: base64.RawURLEncoding.EncodeToString(id), PublicKey: base64.StdEncoding.EncodeToString(ephemeral.PublicKey().Bytes()), Nonce: base64.StdEncoding.EncodeToString(serverNonce), ExpiresAt: now.Add(t.cfg.TTL).Unix()}
	tr := transcript(h, out)
	digest := sha256.Sum256([]byte(tr))
	receive, err := derive(secret, digest[:], "c2s")
	if err != nil {
		failure(w, 500, "SECURE_HANDSHAKE")
		return
	}
	send, err := derive(secret, digest[:], "s2c")
	if err != nil {
		failure(w, 500, "SECURE_HANDSHAKE")
		return
	}
	signing := t.signing
	if h.ClientKind == "web" {
		signing = t.webSigning
	}
	if signing == nil {
		failure(w, 400, "SECURE_CLIENT_KIND")
		return
	}
	rr, ss, err := ecdsa.Sign(rand.Reader, signing, digest[:])
	if err != nil {
		failure(w, 500, "SECURE_HANDSHAKE")
		return
	}
	signature := make([]byte, 64)
	rr.FillBytes(signature[:32])
	ss.FillBytes(signature[32:])
	out.Signature = base64.StdEncoding.EncodeToString(signature)
	out.Finished = base64.StdEncoding.EncodeToString(send.Seal(nil, nonce(0, 0), []byte("server-finished"), []byte(tr)))
	t.mu.Lock()
	for id, existing := range t.sessions {
		if !now.Before(existing.expires) {
			delete(t.sessions, id)
		}
	}
	if len(t.sessions) >= t.cfg.MaxSessions {
		t.mu.Unlock()
		failure(w, 503, "SECURE_CAPACITY")
		return
	}
	t.sessions[out.SessionID] = &session{kind: h.ClientKind, id: out.SessionID, expires: time.Unix(out.ExpiresAt, 0), send: send, receive: receive, seen: map[uint64]bool{}}
	t.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}

type requestMeta struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
}
type responseMeta struct {
	Status  int         `json:"status"`
	Headers http.Header `json:"headers"`
}

// Records have a four-byte ciphertext length. Their authenticated plaintext kind
// is metadata (1), bytes (2), or final (3). An authenticated final record is
// mandatory, so truncation is never interpreted as successful EOF.
type records struct {
	reader   io.Reader
	key      cipher.AEAD
	id, dir  string
	seq      uint64
	index    uint32
	buffered []byte
	done     bool
}

func (r *records) record() (byte, []byte, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(r.reader, prefix[:]); err != nil {
		return 0, nil, errRecord
	}
	n := binary.BigEndian.Uint32(prefix[:])
	if n < 17 || n > FrameBytes+1024 || r.index == ^uint32(0) {
		return 0, nil, errRecord
	}
	sealed := make([]byte, n)
	if _, err := io.ReadFull(r.reader, sealed); err != nil {
		return 0, nil, errRecord
	}
	plain, err := r.key.Open(nil, nonce(r.seq, r.index), sealed, aad(r.id, r.seq, r.index, r.dir))
	r.index++
	if err != nil || len(plain) == 0 {
		return 0, nil, errRecord
	}
	return plain[0], plain[1:], nil
}
func (r *records) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(r.buffered) == 0 && !r.done {
		kind, data, err := r.record()
		if err != nil {
			return 0, err
		}
		switch kind {
		case 2:
			if len(data) == 0 {
				return 0, errRecord
			}
			r.buffered = data
		case 3:
			if len(data) != 0 {
				return 0, errRecord
			}
			var b [1]byte
			n, err := r.reader.Read(b[:])
			if n != 0 || err != io.EOF {
				return 0, errRecord
			}
			r.done = true
		default:
			return 0, errRecord
		}
	}
	if r.done {
		return 0, io.EOF
	}
	n := copy(p, r.buffered)
	r.buffered = r.buffered[n:]
	return n, nil
}
func writeRecord(w io.Writer, key cipher.AEAD, id, dir string, seq uint64, index *uint32, kind byte, data []byte) error {
	if len(data) > FrameBytes || *index == ^uint32(0) {
		return errRecord
	}
	plain := append([]byte{kind}, data...)
	sealed := key.Seal(nil, nonce(seq, *index), plain, aad(id, seq, *index, dir))
	*index++
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(sealed)))
	if _, err := w.Write(prefix[:]); err != nil {
		return err
	}
	_, err := w.Write(sealed)
	return err
}

type secureWriter struct {
	written  int64
	expected *int64
	outer    http.ResponseWriter
	session  *session
	seq      uint64
	index    uint32
	headers  http.Header
	started  bool
	err      error
}

func (s *secureWriter) Header() http.Header { return s.headers }
func (s *secureWriter) WriteHeader(status int) {
	if s.started {
		return
	}
	s.started = true
	if value := s.headers.Get("Content-Length"); value != "" {
		n, err := strconv.ParseInt(value, 10, 64)
		if err == nil && n >= 0 {
			s.expected = &n
		}
	}
	s.outer.Header().Set("Content-Type", ContentType)
	s.outer.Header().Set("Cache-Control", "no-store")
	for _, cookie := range s.headers.Values("Set-Cookie") {
		s.outer.Header().Add("Set-Cookie", cookie)
	}
	s.headers.Del("Set-Cookie")
	s.outer.WriteHeader(200)
	meta, _ := json.Marshal(responseMeta{Status: status, Headers: s.headers})
	s.err = writeRecord(s.outer, s.session.send, s.session.id, "s2c", s.seq, &s.index, 1, meta)
}
func (s *secureWriter) Write(p []byte) (int, error) {
	if !s.started {
		s.WriteHeader(200)
	}
	if s.err != nil {
		return 0, s.err
	}
	written := 0
	for len(p) > 0 {
		n := min(len(p), FrameBytes)
		s.err = writeRecord(s.outer, s.session.send, s.session.id, "s2c", s.seq, &s.index, 2, p[:n])
		if s.err != nil {
			return written, s.err
		}
		written += n
		s.written += int64(n)
		p = p[n:]
	}
	return written, nil
}
func (s *secureWriter) Flush() {
	if !s.started {
		s.WriteHeader(200)
	}
	_ = http.NewResponseController(s.outer).Flush()
}
func (s *secureWriter) finish() {
	if !s.started {
		s.WriteHeader(200)
	}
	if s.err == nil && (s.expected == nil || s.written == *s.expected) {
		s.err = writeRecord(s.outer, s.session.send, s.session.id, "s2c", s.seq, &s.index, 3, nil)
	}
}
func (t *Transport) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/secure/client.js" && r.Method == "GET" && t.webSigning != nil {
			BrowserModule(w, r, base64.StdEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), t.webSigning.X, t.webSigning.Y)), true)
			return
		}
		if r.URL.Path == "/api/v1/secure/info" && r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			if t.webSigning == nil {
				failure(w, 503, "SECURE_DISABLED")
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "version": Version, "webPublicKey": base64.StdEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), t.webSigning.X, t.webSigning.Y))})
			return
		}
		if r.URL.Path == handshakePath {
			t.handshake(w, r)
			return
		}
		if r.URL.Path != requestPath {
			if t.cfg.Required && strings.HasPrefix(r.URL.Path, "/api/v1/") && r.URL.Path != "/api/v1/auth/login" && r.URL.Path != "/api/v1/auth/callback" && !(r.URL.Path == "/api/v1/email-approval" && (r.Method == "GET" || r.Method == "HEAD")) && !(r.URL.Path == "/api/v1/email-approval.js" && (r.Method == "GET" || r.Method == "HEAD")) && r.Method != "OPTIONS" {
				failure(w, 426, "SECURE_TRANSPORT_REQUIRED")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != "POST" || r.Header.Get("Content-Type") != ContentType {
			failure(w, 400, "SECURE_REQUEST")
			return
		}
		id := r.Header.Get("X-TableDB-Session")
		seq, err := strconv.ParseUint(r.Header.Get("X-TableDB-Sequence"), 10, 64)
		t.mu.Lock()
		s := t.sessions[id]
		t.mu.Unlock()
		if err != nil || s == nil || !t.now().Before(s.expires) {
			failure(w, 410, "SECURE_SESSION_EXPIRED")
			return
		}
		stream := &records{reader: r.Body, key: s.receive, id: id, dir: "c2s", seq: seq}
		kind, data, err := stream.record()
		if err != nil || kind != 1 || len(data) > 16384 {
			failure(w, 400, "SECURE_RECORD")
			return
		}
		var meta requestMeta
		if json.Unmarshal(data, &meta) != nil || !strings.HasPrefix(meta.Path, "/api/v1/") || strings.HasPrefix(meta.Path, "/api/v1/secure/") || len(meta.Path) > 8192 || (meta.Method != "GET" && meta.Method != "POST" && meta.Method != "PUT" && meta.Method != "DELETE") {
			failure(w, 400, "SECURE_REQUEST")
			return
		}
		inner := r.Clone(context.WithValue(context.WithValue(r.Context(), encryptedKey{}, true), kindKey{}, s.kind))
		inner.Method = meta.Method
		inner.URL, err = inner.URL.Parse(meta.Path)
		if err != nil || inner.URL.Host != "" || inner.URL.Fragment != "" || path.Clean(inner.URL.Path) != inner.URL.Path || strings.HasPrefix(inner.URL.Path, "/api/v1/secure/") {
			failure(w, 400, "SECURE_REQUEST")
			return
		}
		if (strings.HasPrefix(inner.URL.Path, "/api/v1/auth/desktop/") || inner.URL.Path == "/api/v1/desktop/config" || strings.HasPrefix(inner.URL.Path, "/api/v1/agent/")) && s.kind != "desktop" {
			failure(w, 403, "SECURE_CLIENT_KIND")
			return
		}
		if inner.URL.Path == "/api/v1/auth/dev-login" && s.kind != "web" {
			failure(w, 403, "SECURE_CLIENT_KIND")
			return
		}
		inner.RequestURI = inner.URL.RequestURI()
		inner.Header = r.Header.Clone()
		inner.Header.Del("Authorization")
		if s.kind == "desktop" {
			inner.Header.Del("Cookie")
		}
		inner.Header.Del("Content-Type")
		inner.Header.Del("Content-Length")
		for k, v := range meta.Headers {
			switch strings.ToLower(k) {
			case "authorization", "content-type", "accept", "x-csrf-token", "idempotency-key", "x-part-sha256":
			default:
				failure(w, 400, "SECURE_REQUEST")
				return
			}
			if len(v) > 8192 || strings.ContainsAny(v, "\r\n") {
				failure(w, 400, "SECURE_REQUEST")
				return
			}
			inner.Header.Set(k, v)
		}
		if !s.accept(seq) {
			failure(w, 409, "SECURE_REPLAY")
			return
		}
		select {
		case t.slots <- struct{}{}:
			defer func() { <-t.slots }()
		default:
			failure(w, 429, "SECURE_CAPACITY")
			return
		}
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(120 * time.Second))
		defer http.NewResponseController(w).SetReadDeadline(time.Time{})
		// Validate the authenticated final record before dispatching any mutation.
		// Uploads already arrive as bounded parts; downloads stay streamed.
		payload, err := io.ReadAll(io.LimitReader(stream, t.cfg.MaxRequestBytes+1))
		if err != nil || int64(len(payload)) > t.cfg.MaxRequestBytes || (meta.Method == "GET" && len(payload) != 0) {
			failure(w, 400, "SECURE_RECORD")
			return
		}
		inner.Body = io.NopCloser(bytes.NewReader(payload))
		inner.ContentLength = int64(len(payload))
		_ = http.NewResponseController(w).SetReadDeadline(time.Time{})
		responseHeaders := make(http.Header)
		if id := w.Header().Get("X-Request-ID"); id != "" {
			responseHeaders.Set("X-Request-ID", id)
		}
		encrypted := &secureWriter{outer: w, session: s, seq: seq, headers: responseHeaders}
		next.ServeHTTP(encrypted, inner)
		encrypted.finish()
	})
}
