package inspect

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/shared"
)

var driveRe = regexp.MustCompile(`^[A-Za-z]:`)

// isZipSlip flags names that would escape the extraction directory: parent segments, absolute paths, drive letters, UNC.
func isZipSlip(name string) bool {
	n := strings.ReplaceAll(name, "\\", "/")
	if strings.ContainsRune(n, 0) || strings.HasPrefix(n, "/") || driveRe.MatchString(n) {
		return true
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// eocdCount reads the entry count from the end-of-central-directory record (zip64 aware) without loading the directory.
func eocdCount(ra io.ReaderAt, size int64) (int64, bool) {
	const maxTail = 65535 + 22 + 20
	n := int64(maxTail)
	if size < n {
		n = size
	}
	buf := make([]byte, n)
	if _, err := ra.ReadAt(buf, size-n); err != nil && err != io.EOF {
		return 0, false
	}
	i := bytes.LastIndex(buf, []byte("PK\x05\x06"))
	if i < 0 || i+22 > len(buf) {
		return 0, false
	}
	total := int64(binary.LittleEndian.Uint16(buf[i+10:]))
	if total == 0xFFFF && i >= 20 && bytes.Equal(buf[i-20:i-16], []byte("PK\x06\x07")) {
		off := int64(binary.LittleEndian.Uint64(buf[i-12:]))
		rec := make([]byte, 56)
		if _, err := ra.ReadAt(rec, off); err == nil && bytes.Equal(rec[:4], []byte("PK\x06\x06")) {
			total = int64(binary.LittleEndian.Uint64(rec[32:]))
		}
	}
	return total, true
}

type zipWalker struct {
	opt      Options
	g        *guard
	entries  []Entry
	sum      ZipInfo
	sens     shared.SensitiveCounts
	hasExec  bool
	reasons  map[string]bool
	topCount int64
}

func (w *zipWalker) truncate(reason string) { w.reasons[reason] = true }

func (w *zipWalker) reasonString() string {
	var rs []string
	for r := range w.reasons {
		rs = append(rs, r)
	}
	sort.Strings(rs)
	return strings.Join(rs, ",")
}

func (w *zipWalker) walk(ra io.ReaderAt, size int64, depth int, prefix string) error {
	cnt, ok := eocdCount(ra, size)
	if ok && depth == 1 {
		w.sum.EntryCount = int(cnt)
	}
	if ok && cnt > int64(w.opt.MaxEntries)*10 {
		w.truncate("too-many-entries")
		return nil
	}
	zr, err := zip.NewReader(ra, size)
	if err != nil {
		return fmt.Errorf("not a readable zip archive: %w", err)
	}
	if depth == 1 && !ok {
		w.sum.EntryCount = len(zr.File)
	}
	for _, f := range zr.File {
		if w.g.ctx.Err() != nil {
			w.truncate("timeout")
			return nil
		}
		if len(w.entries) >= w.opt.MaxEntries {
			w.truncate("entry-cap")
			return nil
		}
		w.entry(f, depth, prefix)
	}
	return nil
}

func (w *zipWalker) entry(f *zip.File, depth int, prefix string) {
	e := Entry{Idx: len(w.entries), Path: prefix + SanitizeName(f.Name, 512), CompressedSize: int64(f.CompressedSize64), Size: int64(f.UncompressedSize64),
		Depth: depth, Flags: []string{}}
	e.IsDir = strings.HasSuffix(f.Name, "/") || strings.HasSuffix(f.Name, "\\")
	e.CRC32 = fmt.Sprintf("%08x", f.CRC32)
	if m := f.Modified; !m.IsZero() && m.Year() >= 1980 {
		e.Modified = m.UTC().Format(time.RFC3339)
	}
	e.Encrypted = f.Flags&0x1 != 0 || f.Method == 99
	e.ZipSlip = isZipSlip(f.Name)
	flag := func(s string) { e.Flags = append(e.Flags, s) }
	if e.ZipSlip {
		flag("zip-slip")
		w.sum.ZipSlipCount++
	}
	if e.Encrypted {
		flag("encrypted")
		w.sum.EncryptedCount++
	}
	if e.IsDir {
		w.sum.DirCount++
	} else {
		w.sum.FileCount++
	}
	w.sum.TotalCompressed += e.CompressedSize
	w.sum.TotalUncompressed += e.Size
	ratio := 0.0
	if e.CompressedSize > 0 {
		ratio = float64(e.Size) / float64(e.CompressedSize)
	} else if e.Size > 0 {
		ratio = float64(e.Size)
	}
	if ratio > w.sum.MaxRatio {
		w.sum.MaxRatio = ratio
	}
	idx := len(w.entries)
	w.entries = append(w.entries, e)
	if !e.IsDir && !e.Encrypted {
		w.inspectEntry(f, idx, depth, prefix, ratio)
	}
	// flags may have been appended on the stored copy; keep the order stable
}

func (w *zipWalker) inspectEntry(f *zip.File, idx, depth int, prefix string, ratio float64) {
	e := &w.entries[idx]
	flag := func(s string) { e.Flags = append(e.Flags, s) }
	if ratio > w.opt.MaxRatio && e.Size > 1<<20 {
		flag("bomb-ratio")
		w.truncate("ratio-cap")
		return
	}
	if w.g.remaining <= 0 {
		w.truncate("byte-budget")
		return
	}
	rc, err := f.Open()
	if err != nil {
		flag("unreadable")
		return
	}
	defer rc.Close()
	gr := &guardReader{r: io.LimitReader(rc, e.Size+1), g: w.g}
	cnt := &countingReader{r: gr}
	br := bufio.NewReaderSize(cnt, 64<<10)
	head, _ := br.Peek(4096)
	kind := sniffKind(head)
	ext := Ext(f.Name)
	e.DetectedType = kind
	if kind == "text" {
		e.DetectedType = textKindFor(ext)
	}
	if mm, _ := mismatch(ext, kind); mm {
		flag("mismatch")
	}
	if isExecutableKind(kind) {
		flag("executable")
		w.hasExec = true
	}
	var h hash.Hash
	var rd io.Reader = br
	if e.Size <= w.opt.EntryHashMaxBytes {
		h = sha256.New()
		rd = io.TeeReader(br, h)
	}
	var rerr error
	switch {
	case kind == "text" || kind == "script":
		tk := e.DetectedType
		if kind == "script" {
			tk = "text"
		}
		ti, sc, err := analyzeText(rd, tk, w.opt)
		rerr = err
		lines := ti.Lines
		e.Lines = &lines
		if ti.CSV != nil {
			rows, cols := ti.CSV.DataRows, ti.CSV.Columns
			e.Rows, e.Columns = &rows, &cols
		}
		if sc.Any() {
			flag("sensitive")
			w.sens.Add(sc)
		}
	case kind == "zip":
		e.Nested = true
		flag("nested-archive")
		w.sum.NestedArchiveCount++
		if depth < w.opt.MaxDepth && e.Size <= w.opt.NestedMaxBytes {
			var buf bytes.Buffer
			_, rerr = io.Copy(&buf, rd)
			if rerr == nil && int64(buf.Len()) == e.Size {
				if nerr := w.walk(bytes.NewReader(buf.Bytes()), int64(buf.Len()), depth+1, e.Path+"!/"); nerr != nil {
					w.entries[idx].Flags = append(w.entries[idx].Flags, "unreadable")
				}
			}
		} else {
			w.truncate("nested-depth")
			// listed, not opened
			if h != nil {
				_, rerr = io.Copy(io.Discard, rd)
			}
		}
	default:
		if h != nil {
			_, rerr = io.Copy(io.Discard, rd)
		} else {
			flag("too-large")
		}
	}
	e = &w.entries[idx] // entries may have been reallocated by the nested walk
	w.sum.InspectedEntries++
	switch {
	case rerr == nil:
		if cnt.n > e.Size {
			e.Flags = append(e.Flags, "size-mismatch")
		}
		if h != nil && cnt.n == e.Size {
			e.SHA256 = hex.EncodeToString(h.Sum(nil))
		}
	case errors.Is(rerr, errBudget):
		w.truncate("byte-budget")
	case errors.Is(rerr, context.DeadlineExceeded), errors.Is(rerr, context.Canceled):
		w.truncate("timeout")
	case errors.Is(rerr, zip.ErrChecksum):
		e.Flags = append(e.Flags, "crc-error")
	default:
		e.Flags = append(e.Flags, "unreadable")
	}
}
