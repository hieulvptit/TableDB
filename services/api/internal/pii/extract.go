package pii

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
	"io"
	"math/big"
	"path/filepath"
	"strings"
	"unicode/utf8"
	"vnpay/tabledb-api/internal/config"
)

type textSample struct {
	Lines                       []string
	Coverage                    string
	TotalLines                  int64
	ListedFiles, EncryptedFiles int
	Reason                      string
	Truncated                   bool
}
type reservoir struct {
	result textSample
	count  int64
	pinned int
	limit  int
	choose func(int64) (int64, error)
}

func randomIndex(n int64) (int64, error) {
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		return 0, err
	}
	return v.Int64(), nil
}
func (s *reservoir) add(line string) error {
	s.result.TotalLines++
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	s.count++
	// Limit one sampled line, not the number of candidate lines read.
	runes := []rune(line)
	if len(runes) > 1000 {
		line = string(runes[:1000])
		s.result.Truncated = true
	}
	if len(s.result.Lines) < s.limit {
		s.result.Lines = append(s.result.Lines, line)
		return nil
	}
	var idx int64
	var err error
	capacity := s.limit - s.pinned
	if capacity > 0 {
		idx, err = s.choose(s.count)
		if err != nil {
			return err
		}
		if idx < int64(capacity) {
			s.result.Lines[s.pinned+int(idx)] = line
		}
	}
	return nil
}
func (s *reservoir) header(line string) error {
	s.result.TotalLines++
	if s.pinned >= s.limit {
		return nil
	}
	runes := []rune(line)
	if len(runes) > 1000 {
		line = string(runes[:1000])
		s.result.Truncated = true
	}
	s.result.Lines = append(s.result.Lines, "")
	copy(s.result.Lines[s.pinned+1:], s.result.Lines[s.pinned:])
	s.result.Lines[s.pinned] = line
	s.pinned++
	if len(s.result.Lines) > s.limit {
		s.result.Lines = s.result.Lines[:s.limit]
	}
	return nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(b)
}

// sampleFile reads candidate lines throughout the file using reservoir sampling.
// LLM input is bounded independently of the file size. ZIP ReaderAt avoids
// loading an encrypted archive merely to list its central directory.
func sampleFile(ctx context.Context, name string, r io.Reader, c config.PII) (textSample, error) {
	if c.SampleLines <= 0 || c.MaxTextBytes <= 0 || c.MaxFileBytes <= 0 {
		return textSample{}, fmt.Errorf("invalid PII sample limits")
	}
	s := &reservoir{result: textSample{Lines: []string{}, Coverage: "sampled"}, limit: c.SampleLines, choose: randomIndex}
	entries := 1000
	if err := sampleReader(ctx, name, r, c, s, &entries, 0); err != nil {
		return s.result, err
	}
	if s.result.Coverage == "metadata_only" {
		s.result.Lines = []string{}
		return s.result, nil
	}
	// Payload caps never turn a sample into a claim of full-file coverage.
	for int64(len(strings.Join(s.result.Lines, "\n"))) > c.MaxTextBytes {
		s.result.Truncated = true
		last := len(s.result.Lines) - 1
		if last < 0 {
			break
		}
		s.result.Lines = s.result.Lines[:last]
	}
	return s.result, nil
}

func sampleReader(ctx context.Context, name string, r io.Reader, c config.PII, s *reservoir, entries *int, depth int) error {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".zip", ".docx", ".xlsx", ".pptx":
		if depth >= 2 {
			return fmt.Errorf("PII archive nesting limit exceeded")
		}
		var at io.ReaderAt
		var size int64
		if sized, ok := r.(interface {
			io.ReaderAt
			Size() int64
		}); ok {
			at, size = sized, sized.Size()
		} else {
			b, err := io.ReadAll(io.LimitReader(contextReader{ctx, r}, c.MaxFileBytes+1))
			if err != nil {
				return fmt.Errorf("cannot read PII archive")
			}
			if int64(len(b)) > c.MaxFileBytes {
				return fmt.Errorf("PII archive requires random-access reader or exceeds archive limit")
			}
			at, size = bytes.NewReader(b), int64(len(b))
		}
		count, err := archiveCount(at, size)
		if err != nil || count > *entries {
			return fmt.Errorf("invalid or oversized PII archive directory")
		}
		z, err := zip.NewReader(at, size)
		if err != nil {
			return fmt.Errorf("unreadable PII archive directory")
		}
		*entries -= len(z.File)
		if *entries < 0 {
			return fmt.Errorf("PII archive entry limit exceeded")
		}
		for _, f := range z.File {
			if f.FileInfo().IsDir() {
				continue
			}
			s.result.ListedFiles++
			if f.Flags&1 != 0 {
				s.result.EncryptedFiles++
			}
		}
		if s.result.EncryptedFiles > 0 {
			s.result.Coverage = "metadata_only"
			s.result.Reason = "encrypted_zip"
			return nil
		}
		var expanded int64
		for _, f := range z.File {
			if f.FileInfo().IsDir() {
				continue
			}
			if f.UncompressedSize64 > uint64(c.MaxFileBytes) || int64(f.UncompressedSize64) > c.MaxFileBytes-expanded {
				return fmt.Errorf("PII archive expansion limit exceeded")
			}
			expanded += int64(f.UncompressedSize64)
			entry, err := f.Open()
			if err != nil {
				return fmt.Errorf("unreadable PII archive entry")
			}
			entryName := f.Name
			if ext != ".zip" && strings.HasSuffix(strings.ToLower(entryName), ".rels") {
				entryName += ".xml"
			}
			err = sampleReader(ctx, entryName, entry, c, s, entries, depth+1)
			closeErr := entry.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return fmt.Errorf("PII archive entry read failed")
			}
		}
		return nil
	case ".txt", ".csv", ".tsv", ".json", ".jsonl", ".sql", ".log", ".md", ".yaml", ".yml", ".ini", ".properties", ".conf", ".html", ".xml":
	default:
		return fmt.Errorf("unsupported format for PII line sampling (PDF/images/binary require another extractor)")
	}
	text, err := textReader(contextReader{ctx, r})
	if err != nil {
		return err
	}
	if ext == ".xml" {
		d := xml.NewDecoder(text)
		for {
			tok, err := d.Token()
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return fmt.Errorf("invalid XML for PII sampling")
			}
			switch v := tok.(type) {
			case xml.CharData:
				if err := s.add(string(v)); err != nil {
					return err
				}
			case xml.StartElement:
				for _, a := range v.Attr {
					if err := s.add(a.Value); err != nil {
						return err
					}
				}
			}
		}
	}
	scanner := bufio.NewScanner(text)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	first := true
	for scanner.Scan() {
		line := scanner.Text()
		if !validText(line) {
			return fmt.Errorf("binary or invalid encoding in PII text")
		}
		if first {
			first = false
			if err := s.header(line); err != nil {
				return err
			}
		} else if err := s.add(line); err != nil {
			return err
		}
	}
	if scanner.Err() != nil {
		return fmt.Errorf("PII text reading failed or line exceeds 1 MiB")
	}
	return nil
}

func textReader(r io.Reader) (io.Reader, error) {
	b := bufio.NewReader(r)
	head, err := b.Peek(2)
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("PII text read failed")
	}
	if len(head) == 2 && (bytes.Equal(head, []byte{0xff, 0xfe}) || bytes.Equal(head, []byte{0xfe, 0xff})) {
		return transform.NewReader(b, unicode.UTF16(unicode.LittleEndian, unicode.ExpectBOM).NewDecoder()), nil
	}
	head, _ = b.Peek(3)
	if bytes.Equal(head, []byte{0xef, 0xbb, 0xbf}) {
		_, _ = b.Discard(3)
	}
	return b, nil
}
func validText(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c < 32 && c != '\t' && c != '\r' && c != '\n' {
			return false
		}
	}
	return true
}

func archiveCount(r io.ReaderAt, size int64) (int, error) {
	if size < 22 {
		return 0, fmt.Errorf("invalid ZIP")
	}
	n := int64(65557)
	if size < n {
		n = size
	}
	b := make([]byte, n)
	if _, err := r.ReadAt(b, size-n); err != nil && err != io.EOF {
		return 0, err
	}
	i := bytes.LastIndex(b, []byte("PK\x05\x06"))
	if i < 0 || i+22 > len(b) {
		return 0, fmt.Errorf("ZIP directory not found")
	}
	count := int(binary.LittleEndian.Uint16(b[i+10:]))
	if count == 65535 {
		return 0, fmt.Errorf("ZIP64 directory exceeds listing limit")
	}
	return count, nil
}
