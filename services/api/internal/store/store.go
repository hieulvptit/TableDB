// Package store: ciphertext-only file storage. Prod may swap in an S3-compatible adapter with the same contract.
package store

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

type FileStore interface {
	Put(key string, data []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
	Exists(key string) bool
	Ping() bool
}

var keyRe = regexp.MustCompile(`^[0-9a-f-]{36}/\d{1,6}$`)

var ErrInvalidKey = errors.New("invalid storage key")

type Local struct{ Dir string }

func NewLocal(dir string) *Local { return &Local{Dir: dir} }

func (l *Local) path(key string) (string, error) {
	if !keyRe.MatchString(key) { // blocks traversal
		return "", ErrInvalidKey
	}
	return filepath.Join(l.Dir, key), nil
}

func (l *Local) Put(key string, data []byte) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(p), ".part-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (l *Local) Get(key string) ([]byte, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(p)
}

func (l *Local) Delete(key string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (l *Local) Exists(key string) bool {
	p, err := l.path(key)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func (l *Local) Ping() bool { return os.MkdirAll(l.Dir, 0o700) == nil }
