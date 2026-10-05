package crypto

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestSealOpenAADAndTamper(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	ct, err := SealBuffer(key, []byte("hello"), []byte("part:T:1"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ct) != 12+16+5 {
		t.Fatalf("layout iv|tag|ct expected, got %d bytes", len(ct))
	}
	if pt, err := OpenBuffer(key, ct, []byte("part:T:1")); err != nil || string(pt) != "hello" {
		t.Fatalf("%q %v", pt, err)
	}
	if _, err := OpenBuffer(key, ct, []byte("part:T:2")); err == nil {
		t.Fatal("AAD must bind the part index")
	}
	ct[len(ct)-1] ^= 1
	if _, err := OpenBuffer(key, ct, []byte("part:T:1")); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
	if _, err := OpenBuffer(key, []byte("short"), nil); err == nil {
		t.Fatal("short input accepted")
	}
}

// A ciphertext produced by the Node implementation (crypto.ts seal(): base64url(iv|tag|ct), AAD "wrap") must open here.
func TestNodeCompatibleWrap(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	kp, _ := NewStaticKeyProvider(base64.StdEncoding.EncodeToString(key))
	w, err := kp.Wrap([]byte("dek-bytes-dek-bytes-dek-bytes-32"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(w)
	if err != nil || len(raw) != 12+16+32 {
		t.Fatalf("wire format: %d bytes, %v", len(raw), err)
	}
	got, err := kp.Unwrap(w)
	if err != nil || string(got) != "dek-bytes-dek-bytes-dek-bytes-32" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestHelpers(t *testing.T) {
	if Sha256HexString("abc") != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatal("sha256")
	}
	if !SafeEqual("a", "a") || SafeEqual("a", "b") || SafeEqual("a", "ab") {
		t.Fatal("SafeEqual")
	}
	if a, b := RandomToken(32), RandomToken(32); a == b || len(a) != 43 {
		t.Fatalf("RandomToken %q %q", a, b)
	}
}

// Ciphertexts produced by the Node implementation (services/api/src/crypto.ts) must open in Go (existing data stays readable).
func TestOpensNodeCiphertext(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	kp, _ := NewStaticKeyProvider(base64.StdEncoding.EncodeToString(key))
	dek, err := kp.Unwrap("NjThUQzymK3PnpAYWsl2ne6ZlwDQ98yVJZuQkFbteWauADcbsvzhwnzrezz2MsTbWa6T-BEuGn-Pb-Q5")
	if err != nil || string(dek) != "dek-bytes-dek-bytes-dek-bytes-32" {
		t.Fatalf("unwrap node DEK: %q %v", dek, err)
	}
	raw, _ := base64.StdEncoding.DecodeString("HpeXAFcfieZT4fojdyurlbgMk39Ljs3ibliE2p77lcfKTvAkuA==")
	pt, err := OpenBuffer(key, raw, []byte("part:T:1"))
	if err != nil || string(pt) != "part-data" {
		t.Fatalf("open node part: %q %v", pt, err)
	}
}
