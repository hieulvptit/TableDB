package store

import "testing"

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
