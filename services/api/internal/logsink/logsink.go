// Package logsink: file logging with size/age rotation + compression (Windows-safe: lumberjack closes the live file before
// renaming it), the audit file sink and the helpers the disk janitor uses to find rotated segments.
package logsink

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	lumberjack "gopkg.in/natefinch/lumberjack.v2"
)

const (
	AppLogName    = "app.log"
	AuditFileName = "audit.jsonl"
	markerName    = "audit.verified.json"
	cursorName    = "audit.cursor"
)

type Options struct {
	Dir        string
	MaxSizeMB  int
	MaxAgeDays int // 0 = never by age
	MaxBackups int // 0 = unlimited
	Daily      bool
}

// Rolling is a rotating, compressing file writer.
type Rolling struct {
	*lumberjack.Logger
	mu   sync.Mutex
	last string // date of the last daily rotation check
	opts Options
}

// NewRolling creates (the directory and) a rolling writer for dir/name. Rotated segments are gzip-compressed.
func NewRolling(name string, o Options) (*Rolling, error) {
	if err := os.MkdirAll(o.Dir, 0o750); err != nil {
		return nil, err
	}
	return &Rolling{opts: o, last: time.Now().Format("2006-01-02"), Logger: &lumberjack.Logger{
		Filename: filepath.Join(o.Dir, name), MaxSize: o.MaxSizeMB, MaxAge: o.MaxAgeDays, MaxBackups: o.MaxBackups, LocalTime: true, Compress: true}}, nil
}

// Write rotates first when the local date changed (age based rotation) and then appends.
func (r *Rolling) Write(p []byte) (int, error) {
	if r.opts.Daily {
		today := time.Now().Format("2006-01-02")
		r.mu.Lock()
		if today != r.last {
			r.last = today
			_ = r.Logger.Rotate()
		}
		r.mu.Unlock()
	}
	return r.Logger.Write(p)
}

// Segment is a rotated (closed) log file.
type Segment struct {
	Path    string
	Size    int64
	ModTime time.Time
}

// Segments lists rotated segments of base (e.g. "app.log" -> app-<ts>.log[.gz]), oldest first. The live file is excluded.
func Segments(dir, base string) ([]Segment, error) {
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Segment
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, stem+"-") || !(strings.HasSuffix(n, ext) || strings.HasSuffix(n, ext+".gz")) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Segment{Path: filepath.Join(dir, n), Size: info.Size(), ModTime: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ModTime.Equal(out[j].ModTime) {
			return out[i].Path < out[j].Path
		}
		return out[i].ModTime.Before(out[j].ModTime)
	})
	return out, nil
}

// DirSize is the total size of the regular files below dir.
func DirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if i, e := d.Info(); e == nil {
				n += i.Size()
			}
		}
		return nil
	})
	return n
}

// ---- verification marker: rotated audit file segments may only be removed once the DB chain was verified (or fully exported)
// after they were closed. The DB stays the authoritative record either way.

type Marker struct {
	At         time.Time `json:"at"`
	OK         bool      `json:"ok"`
	ThroughSeq int64     `json:"throughSeq"`
	Source     string    `json:"source"` // verify | export
}

func WriteMarker(dir string, m Marker) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	b, _ := json.Marshal(m)
	return writeAtomic(filepath.Join(dir, markerName), b)
}

func ReadMarker(dir string) (Marker, bool) {
	var m Marker
	b, err := os.ReadFile(filepath.Join(dir, markerName))
	if err != nil || json.Unmarshal(b, &m) != nil {
		return m, false
	}
	return m, true
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path) // replaces an existing file on Windows too (MoveFileEx REPLACE_EXISTING)
}
