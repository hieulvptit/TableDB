// Package inspect builds a privacy-preserving content manifest of an uploaded file: METADATA ONLY
// (type, sizes, line counts, column counts, archive entry lists, counts of sensitive-looking patterns).
// File content and cell values are never stored. All analysis is streamed with bounded memory and time.
package inspect

import (
	"io"
	"time"

	"vnpay/tabledb-api/internal/shared"
)

const ManifestVersion = 1

// Options bound the work done on one file. Zero fields fall back to DefaultOptions.
type Options struct {
	MaxDepth          int           // archive nesting inspected (1 = only the uploaded archive)
	MaxEntries        int           // archive entries listed (all levels)
	MaxTotalBytes     int64         // uncompressed bytes read while inspecting (all entries together)
	MaxRatio          float64       // per-entry compression ratio above which content is not read
	Timeout           time.Duration // wall clock
	EntryHashMaxBytes int64         // per-entry sha256 only up to this uncompressed size
	NestedMaxBytes    int64         // nested archives larger than this are listed but not opened
	MaxHeaderNames    int
	MaxHeaderNameLen  int
	MaxLineAnalyze    int // bytes of one line kept for pattern/CSV analysis
}

func DefaultOptions() Options {
	return Options{MaxDepth: 2, MaxEntries: 10000, MaxTotalBytes: 1 << 30, MaxRatio: 200, Timeout: 120 * time.Second,
		EntryHashMaxBytes: 64 << 20, NestedMaxBytes: 64 << 20, MaxHeaderNames: 64, MaxHeaderNameLen: 64, MaxLineAnalyze: 64 << 10}
}

func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.MaxDepth <= 0 {
		o.MaxDepth = d.MaxDepth
	}
	if o.MaxEntries <= 0 {
		o.MaxEntries = d.MaxEntries
	}
	if o.MaxTotalBytes <= 0 {
		o.MaxTotalBytes = d.MaxTotalBytes
	}
	if o.MaxRatio <= 0 {
		o.MaxRatio = d.MaxRatio
	}
	if o.Timeout <= 0 {
		o.Timeout = d.Timeout
	}
	if o.EntryHashMaxBytes <= 0 {
		o.EntryHashMaxBytes = d.EntryHashMaxBytes
	}
	if o.NestedMaxBytes <= 0 {
		o.NestedMaxBytes = d.NestedMaxBytes
	}
	if o.MaxHeaderNames <= 0 {
		o.MaxHeaderNames = d.MaxHeaderNames
	}
	if o.MaxHeaderNameLen <= 0 {
		o.MaxHeaderNameLen = d.MaxHeaderNameLen
	}
	if o.MaxLineAnalyze <= 0 {
		o.MaxLineAnalyze = d.MaxLineAnalyze
	}
	return o
}

type CSVInfo struct {
	Delimiter       string   `json:"delimiter"`
	Columns         int      `json:"columns"`
	HeaderNames     []string `json:"headerNames"`
	HeaderTruncated bool     `json:"headerTruncated"`
	DataRows        int64    `json:"dataRows"`
	RaggedRows      int64    `json:"raggedRows"`
}

type JSONInfo struct {
	Valid    bool   `json:"valid"`
	TopLevel string `json:"topLevel"` // object|array|string|number|boolean|null|""
	Length   int64  `json:"length"`   // array length or object key count
	MaxDepth int    `json:"maxDepth"`
	Error    string `json:"error,omitempty"`
}

type JSONLInfo struct {
	ValidLines   int64 `json:"validLines"`
	InvalidLines int64 `json:"invalidLines"`
}

type TextInfo struct {
	Encoding     string     `json:"encoding"` // utf-8|utf-8-bom|utf-16le|utf-16be|other
	Lines        int64      `json:"lines"`
	Bytes        int64      `json:"bytes"`
	EmptyLines   int64      `json:"emptyLines"`
	MaxLineBytes int64      `json:"maxLineBytes"`
	CSV          *CSVInfo   `json:"csv,omitempty"`
	JSON         *JSONInfo  `json:"json,omitempty"`
	JSONL        *JSONLInfo `json:"jsonl,omitempty"`
}

type ZipInfo struct {
	EntryCount         int     `json:"entryCount"` // entries in the archive's central directory (top level)
	FileCount          int     `json:"fileCount"`  // listed entries (all levels) that are files
	DirCount           int     `json:"dirCount"`
	TotalCompressed    int64   `json:"totalCompressed"`
	TotalUncompressed  int64   `json:"totalUncompressed"` // as declared by the archive headers
	EncryptedCount     int     `json:"encryptedCount"`
	ZipSlipCount       int     `json:"zipSlipCount"`
	NestedArchiveCount int     `json:"nestedArchiveCount"`
	MaxRatio           float64 `json:"maxRatio"`
	InspectedEntries   int     `json:"inspectedEntries"` // entries whose content was streamed
}

// Manifest is the summary (small; stored as JSON next to the entry list).
type Manifest struct {
	Version                   int                     `json:"version"`
	Size                      int64                   `json:"size"`
	SHA256                    string                  `json:"sha256"`
	DeclaredExt               string                  `json:"declaredExt"`
	DetectedType              string                  `json:"detectedType"`
	Label                     string                  `json:"label"`
	TypeMismatch              bool                    `json:"typeMismatch"`
	MismatchNote              string                  `json:"mismatchNote,omitempty"`
	Executable                bool                    `json:"executable"`
	ContainsExecutable        bool                    `json:"containsExecutable"`
	ContainsSensitivePatterns bool                    `json:"containsSensitivePatterns"`
	Sensitive                 *shared.SensitiveCounts `json:"sensitive,omitempty"`
	Truncated                 bool                    `json:"truncated"`
	TruncatedReason           string                  `json:"truncatedReason,omitempty"`
	ParseError                string                  `json:"parseError,omitempty"`
	Text                      *TextInfo               `json:"text,omitempty"`
	Zip                       *ZipInfo                `json:"zip,omitempty"`
}

type Entry struct {
	Idx            int      `json:"idx"`
	Path           string   `json:"path"`
	IsDir          bool     `json:"isDir"`
	CompressedSize int64    `json:"compressedSize"`
	Size           int64    `json:"size"`
	Modified       string   `json:"modified"`
	CRC32          string   `json:"crc32"`
	SHA256         string   `json:"sha256,omitempty"`
	Encrypted      bool     `json:"encrypted"`
	ZipSlip        bool     `json:"zipSlip"`
	Nested         bool     `json:"nested"`
	Depth          int      `json:"depth"`
	DetectedType   string   `json:"detectedType,omitempty"`
	Lines          *int64   `json:"lines,omitempty"`
	Rows           *int64   `json:"rows,omitempty"`
	Columns        *int     `json:"columns,omitempty"`
	Flags          []string `json:"flags"`
}

// Result is what Run returns: the summary and the full entry list (archives only).
type Result struct {
	Manifest   Manifest
	Entries    []Entry
	DurationMs int64
}

// Input is the file to inspect. RA must allow random access (archives); SHA256 is the already verified digest.
type Input struct {
	Name   string
	Size   int64
	SHA256 string
	RA     io.ReaderAt
}
