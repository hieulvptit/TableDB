// Package crypto: AES-256-GCM sealing with AAD, DEK wrapping through a KeyProvider (crypto.ts).
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func Sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
func Sha256HexString(s string) string { return Sha256Hex([]byte(s)) }

// RandomToken returns n random bytes as unpadded base64url.
func RandomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// SafeEqual compares in constant time (length leak only, like the Node version).
func SafeEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// KeyProvider is the key-encryption-key source. Prod: implement against the VNPAY KMS/HSM.
type KeyProvider interface {
	Wrap(plain []byte) (string, error)
	Unwrap(wrapped string) ([]byte, error)
}

type StaticKeyProvider struct{ key []byte }

// decodeB64 is as lenient as Node's Buffer.from(x, 'base64'): std or url alphabet, padded or not.
func decodeB64(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(s)
}

func NewStaticKeyProvider(base64Key string) (*StaticKeyProvider, error) {
	k, err := decodeB64(base64Key)
	if err != nil || len(k) != 32 {
		return nil, errors.New("DATA_KEY must be 32 bytes base64")
	}
	return &StaticKeyProvider{key: k}, nil
}

var wrapAAD = []byte("wrap")

func (s *StaticKeyProvider) Wrap(plain []byte) (string, error) { return Seal(s.key, plain, wrapAAD) }
func (s *StaticKeyProvider) Unwrap(w string) ([]byte, error)   { return Open(s.key, w, wrapAAD) }

// SealBuffer encrypts to raw bytes: iv(12) | tag(16) | ciphertext.
func SealBuffer(key, plain, aad []byte) ([]byte, error) {
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	sealed := g.Seal(nil, iv, plain, aad) // ciphertext || tag
	ct, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	out := make([]byte, 0, 12+16+len(ct))
	out = append(out, iv...)
	out = append(out, tag...)
	out = append(out, ct...)
	return out, nil
}

// OpenBuffer reverses SealBuffer; fails on any tampering or AAD mismatch.
func OpenBuffer(key, b, aad []byte) ([]byte, error) {
	if len(b) < 28 {
		return nil, errors.New("ciphertext too short")
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	iv, tag, ct := b[:12], b[12:28], b[28:]
	buf := make([]byte, 0, len(ct)+16)
	buf = append(buf, ct...)
	buf = append(buf, tag...)
	return g.Open(nil, iv, buf, aad)
}

// Seal: base64url(iv12 | tag16 | ciphertext).
func Seal(key, plain, aad []byte) (string, error) {
	b, err := SealBuffer(key, plain, aad)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func Open(key []byte, s string, aad []byte) ([]byte, error) {
	b, err := decodeB64(s)
	if err != nil {
		return nil, err
	}
	return OpenBuffer(key, b, aad)
}

type secretBlob struct {
	W string `json:"w"`
	C string `json:"c"`
}

// EncryptSecret encrypts a short secret under a fresh DEK wrapped by the KEK, binding it to `context`.
func EncryptSecret(kp KeyProvider, plain, context string) (string, error) {
	dek := make([]byte, 32)
	if _, err := rand.Read(dek); err != nil {
		return "", err
	}
	wrapped, err := kp.Wrap(dek)
	if err != nil {
		return "", err
	}
	c, err := Seal(dek, []byte(plain), []byte(context))
	if err != nil {
		return "", err
	}
	b, _ := json.Marshal(secretBlob{W: wrapped, C: c})
	return string(b), nil
}

func DecryptSecret(kp KeyProvider, blob, context string) (string, error) {
	var sb secretBlob
	if err := json.Unmarshal([]byte(blob), &sb); err != nil {
		return "", fmt.Errorf("bad secret blob: %w", err)
	}
	dek, err := kp.Unwrap(sb.W)
	if err != nil {
		return "", err
	}
	pt, err := Open(dek, sb.C, []byte(context))
	return string(pt), err
}
