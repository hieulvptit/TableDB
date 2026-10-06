package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalBlocksPathTraversal(t *testing.T) {
	s := NewLocal(t.TempDir())
	for _, k := range []string{"../../etc/passwd", "00000000-0000-0000-0000-000000000001/../../x", "abc/1", "00000000-0000-0000-0000-000000000001/1/2", ""} {
		if err := s.Put(k, []byte("x")); err != ErrInvalidKey {
			t.Errorf("Put(%q) = %v, want ErrInvalidKey", k, err)
		}
		if s.Exists(k) {
			t.Errorf("Exists(%q)", k)
		}
	}
	const k = "00000000-0000-0000-0000-000000000001/1"
	if err := s.Put(k, []byte("ok")); err != nil {
		t.Fatal(err)
	}
	if b, err := s.Get(k); err != nil || string(b) != "ok" {
		t.Fatalf("%q %v", b, err)
	}
	if !s.Exists(k) || !s.Ping() {
		t.Fatal("exists/ping")
	}
	if err := s.Delete(k); err != nil || s.Exists(k) {
		t.Fatal("delete")
	}
	if err := s.Delete(k); err != nil {
		t.Fatalf("deleting a missing key must be fine: %v", err)
	}
}

func TestConcurrentLocalWritesPublishWholeFile(t *testing.T) {
	s := NewLocal(t.TempDir())
	const key = "00000000-0000-0000-0000-000000000001/1"
	errors := make(chan error, 32)
	for i := 0; i < 32; i++ {
		go func(i int) { errors <- s.Put(key, bytes.Repeat([]byte{byte(i)}, 8192)) }(i)
	}
	for i := 0; i < 32; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 8192 || !bytes.Equal(got, bytes.Repeat(got[:1], 8192)) {
		t.Fatal("partial/interleaved publication")
	}
	files, err := os.ReadDir(filepath.Join(s.Dir, "00000000-0000-0000-0000-000000000001"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatal("temporary files left after publication")
	}
}
