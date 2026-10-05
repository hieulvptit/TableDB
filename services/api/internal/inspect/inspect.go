package inspect

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"vnpay/tabledb-api/internal/shared"
)

// Run inspects one file. It never writes content anywhere, never reads more than Options allow, and converts any panic
// into an error (a malformed file must not crash the worker). The returned Result is usable even with a non-nil error
// from a partial run only when Result != nil.
func Run(parent context.Context, in Input, opt Options) (res *Result, err error) {
	opt = opt.withDefaults()
	start := time.Now()
	ctx, cancel := context.WithTimeout(parent, opt.Timeout)
	defer cancel()
	defer func() {
		if r := recover(); r != nil {
			res, err = nil, fmt.Errorf("inspector panic: %v", r)
		}
	}()
	g := &guard{ctx: ctx, remaining: opt.MaxTotalBytes}
	m := Manifest{Version: ManifestVersion, Size: in.Size, SHA256: in.SHA256, DeclaredExt: Ext(in.Name)}
	headN := int64(4096)
	if in.Size < headN {
		headN = in.Size
	}
	head := make([]byte, headN)
	if headN > 0 {
		if _, rerr := in.RA.ReadAt(head, 0); rerr != nil && rerr != io.EOF {
			return nil, fmt.Errorf("read head: %w", rerr)
		}
	}
	kind := sniffKind(head)
	m.DetectedType = kind
	m.Executable = isExecutableKind(kind)
	m.TypeMismatch, m.MismatchNote = mismatch(m.DeclaredExt, kind)
	res = &Result{}
	var sens shared.SensitiveCounts
	reasons := map[string]bool{}
	section := io.NewSectionReader(in.RA, 0, in.Size)

	switch kind {
	case "zip":
		m.Label = "zip"
		if zipExts[m.DeclaredExt] {
			m.Label = m.DeclaredExt
		}
		w := &zipWalker{opt: opt, g: g, reasons: reasons}
		werr := w.walk(in.RA, in.Size, 1, "")
		if werr != nil {
			m.ParseError = SanitizeName(werr.Error(), 300)
		}
		z := w.sum
		m.Zip = &z
		res.Entries = w.entries
		sens = w.sens
		m.ContainsExecutable = w.hasExec
	case "text", "script":
		tk := textKindFor(m.DeclaredExt)
		m.DetectedType = tk
		m.Label = tk
		if kind == "script" {
			m.DetectedType, m.Label = "script", "script"
		}
		ti, sc, terr := analyzeText(&guardReader{r: section, g: g}, tk, opt)
		m.Text = &ti
		sens = sc
		switch {
		case terr == nil:
		case errors.Is(terr, errBudget):
			reasons["byte-budget"] = true
		case errors.Is(terr, context.DeadlineExceeded), errors.Is(terr, context.Canceled):
			reasons["timeout"] = true
		default:
			return nil, fmt.Errorf("read: %w", terr)
		}
	default:
		m.Label = kind
	}
	if sens.Any() {
		m.Sensitive = &sens
		m.ContainsSensitivePatterns = true
	}
	if len(reasons) > 0 {
		m.Truncated = true
		m.TruncatedReason = joinReasons(reasons)
	}
	if m.Zip != nil && m.Zip.EntryCount > len(res.Entries) && !m.Truncated {
		// listing shorter than the directory: some cap kicked in
		m.Truncated = true
		m.TruncatedReason = "entry-cap"
	}
	res.Manifest = m
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}

func joinReasons(m map[string]bool) string {
	w := &zipWalker{reasons: m}
	return w.reasonString()
}
