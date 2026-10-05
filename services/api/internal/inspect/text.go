package inspect

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"vnpay/tabledb-api/internal/shared"
)

var errBudget = errors.New("inspection byte budget exhausted")

// guard enforces the wall clock (ctx) and the shared uncompressed-byte budget on every read.
type guard struct {
	ctx       context.Context
	remaining int64
}

type guardReader struct {
	r io.Reader
	g *guard
}

func (r *guardReader) Read(p []byte) (int, error) {
	if err := r.g.ctx.Err(); err != nil {
		return 0, err
	}
	if r.g.remaining <= 0 {
		return 0, errBudget
	}
	if int64(len(p)) > r.g.remaining {
		p = p[:r.g.remaining]
	}
	n, err := r.r.Read(p)
	r.g.remaining -= int64(n)
	return n, err
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// utf16Reader converts UTF-16 (LE/BE, BOM already consumed) to UTF-8 on the fly.
type utf16Reader struct {
	r     io.Reader
	be    bool
	raw   []byte
	out   []byte
	carry []byte
	hi    uint16
}

func (u *utf16Reader) Read(p []byte) (int, error) {
	for len(u.out) == 0 {
		if u.raw == nil {
			u.raw = make([]byte, 32<<10)
		}
		n, err := u.r.Read(u.raw)
		b := append(u.carry, u.raw[:n]...)
		u.carry = nil
		if len(b)%2 == 1 {
			u.carry = []byte{b[len(b)-1]}
			b = b[:len(b)-1]
		}
		var units []uint16
		if u.hi != 0 {
			units = append(units, u.hi)
			u.hi = 0
		}
		for i := 0; i+1 < len(b); i += 2 {
			if u.be {
				units = append(units, uint16(b[i])<<8|uint16(b[i+1]))
			} else {
				units = append(units, uint16(b[i+1])<<8|uint16(b[i]))
			}
		}
		if l := len(units); l > 0 && units[l-1] >= 0xD800 && units[l-1] < 0xDC00 {
			u.hi = units[l-1]
			units = units[:l-1]
		}
		for _, r := range utf16.Decode(units) {
			u.out = utf8.AppendRune(u.out, r)
		}
		if err != nil {
			if len(u.out) > 0 {
				break
			}
			return 0, err
		}
	}
	n := copy(p, u.out)
	u.out = u.out[n:]
	return n, nil
}

// textKindFor picks the structural analyser from the extension.
func textKindFor(ext string) string {
	switch ext {
	case "csv", "tsv", "json", "jsonl", "xml", "sql", "md", "log", "txt":
		return ext
	case "ndjson":
		return "jsonl"
	}
	return "text"
}

type textAnalyzer struct {
	opt  Options
	kind string
	info TextInfo
	sens shared.SensitiveCounts

	lineBuf   []byte
	lineLen   int64
	pendingCR bool
	csv       *csvScan
	js        *jsonScan
	jl        *jsonScan
	invalid   bool
	carry     []byte
}

// analyzeText streams r (already guarded) once. It returns what it learned even when the stream ends early with an error.
func analyzeText(r io.Reader, kind string, opt Options) (TextInfo, shared.SensitiveCounts, error) {
	cr := &countingReader{r: r}
	br := bufio.NewReaderSize(cr, 64<<10)
	a := &textAnalyzer{opt: opt, kind: kind}
	a.info.Encoding = "utf-8"
	var src io.Reader = br
	head, _ := br.Peek(3)
	switch {
	case bytes.HasPrefix(head, []byte{0xEF, 0xBB, 0xBF}):
		_, _ = br.Discard(3)
		a.info.Encoding = "utf-8-bom"
	case bytes.HasPrefix(head, []byte{0xFF, 0xFE}):
		_, _ = br.Discard(2)
		a.info.Encoding = "utf-16le"
		src = &utf16Reader{r: br}
	case bytes.HasPrefix(head, []byte{0xFE, 0xFF}):
		_, _ = br.Discard(2)
		a.info.Encoding = "utf-16be"
		src = &utf16Reader{r: br, be: true}
	}
	switch kind {
	case "csv", "tsv":
		a.csv = newCSVScan(kind, opt)
	case "json":
		a.js = newJSONScan(1000)
	case "jsonl":
		a.jl = newJSONScan(1000)
	}
	buf := make([]byte, 32<<10)
	var rerr error
	for {
		n, err := src.Read(buf)
		if n > 0 {
			a.feed(buf[:n])
		}
		if err != nil {
			if err != io.EOF {
				rerr = err
			}
			break
		}
	}
	a.finish()
	a.info.Bytes = cr.n
	if a.invalid && a.info.Encoding == "utf-8" {
		a.info.Encoding = "other"
	}
	if a.csv != nil {
		a.info.CSV = a.csv.result()
	}
	if a.js != nil {
		ok, msg := a.js.Finish()
		if rerr != nil {
			ok, msg = false, "incomplete (inspection stopped early)"
		}
		a.info.JSON = &JSONInfo{Valid: ok, TopLevel: a.js.TopLevel, Length: a.js.Length, MaxDepth: a.js.MaxDepth, Error: msg}
	}
	return a.info, a.sens, rerr
}

func (a *textAnalyzer) feed(p []byte) {
	// encoding sniff for "other" (invalid UTF-8) — only meaningful for non UTF-16 input, harmless otherwise
	if !a.invalid {
		b := p
		if len(a.carry) > 0 {
			b = append(a.carry, p...)
		}
		cut := len(b)
		for k := 1; k <= 3 && k <= len(b); k++ {
			if utf8.RuneStart(b[len(b)-k]) {
				if !utf8.FullRune(b[len(b)-k:]) {
					cut = len(b) - k
				}
				break
			}
		}
		if !utf8.Valid(b[:cut]) {
			a.invalid = true
		}
		a.carry = append(a.carry[:0], b[cut:]...)
	}
	if a.js != nil {
		a.js.Write(p)
	}
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		var seg []byte
		nl := i >= 0
		if nl {
			seg, p = p[:i], p[i+1:]
		} else {
			seg, p = p, nil
		}
		if a.pendingCR {
			a.pendingCR = false
			if !(nl && len(seg) == 0) {
				a.content([]byte{'\r'})
			}
		}
		if nl {
			if n := len(seg); n > 0 && seg[n-1] == '\r' {
				seg = seg[:n-1]
			}
			a.content(seg)
			a.endLine()
		} else {
			if n := len(seg); n > 0 && seg[n-1] == '\r' {
				a.pendingCR = true
				seg = seg[:n-1]
			}
			a.content(seg)
		}
	}
}

func (a *textAnalyzer) content(seg []byte) {
	if len(seg) == 0 {
		return
	}
	a.lineLen += int64(len(seg))
	if a.csv != nil {
		a.csv.bytes(seg)
	}
	if a.jl != nil {
		a.jl.Write(seg)
	}
	room := a.opt.MaxLineAnalyze - len(a.lineBuf)
	if len(seg) <= room {
		a.lineBuf = append(a.lineBuf, seg...)
		return
	}
	a.lineBuf = append(a.lineBuf, seg[:room]...)
	a.flushSensitive(false)
	a.content(seg[room:]) // bounded recursion depth: each level consumes at least len(keep) bytes
}

// flushSensitive scans the buffered part of a long line, keeping the unfinished token for the next window.
func (a *textAnalyzer) flushSensitive(all bool) {
	buf := a.lineBuf
	cut := len(buf)
	if !all {
		if i := bytes.LastIndexAny(buf, " ,;\t\"'|:<>/="); i > 0 {
			cut = i + 1
		}
	}
	a.sens.Add(shared.CountSensitive(buf[:cut]))
	a.lineBuf = append(a.lineBuf[:0], buf[cut:]...)
}

func (a *textAnalyzer) endLine() {
	a.info.Lines++
	if a.lineLen == 0 {
		a.info.EmptyLines++
	}
	if a.lineLen > a.info.MaxLineBytes {
		a.info.MaxLineBytes = a.lineLen
	}
	a.flushSensitive(true)
	if a.csv != nil {
		a.csv.endLine()
	}
	if a.jl != nil {
		if a.jl.started {
			if ok, _ := a.jl.Finish(); ok {
				a.jlInfo().ValidLines++
			} else {
				a.jlInfo().InvalidLines++
			}
		}
		a.jl.Reset()
	}
	a.lineLen = 0
}

func (a *textAnalyzer) jlInfo() *JSONLInfo {
	if a.info.JSONL == nil {
		a.info.JSONL = &JSONLInfo{}
	}
	return a.info.JSONL
}

func (a *textAnalyzer) finish() {
	if a.pendingCR {
		a.pendingCR = false
		a.content([]byte{'\r'})
	}
	if a.lineLen > 0 { // last line without a trailing newline
		a.endLine()
	}
	if a.kind == "jsonl" {
		a.jlInfo()
	}
}

// ---------------------------------------------------------------- CSV

type csvScan struct {
	ext        string
	opt        Options
	delim      byte
	decided    bool
	first      []byte
	inQ        bool
	quoteSeen  bool
	fieldStart bool
	fields     int
	recBytes   int
	field      []byte
	collecting bool
	names      []string
	hdrTrunc   bool
	records    int64
	ragged     int64
	columns    int
}

func newCSVScan(ext string, opt Options) *csvScan {
	c := &csvScan{ext: ext, opt: opt, fieldStart: true, collecting: true}
	if ext == "tsv" {
		c.delim, c.decided = '\t', true
	}
	return c
}

func (c *csvScan) decide() {
	counts := map[byte]int{}
	inQ := false
	for _, b := range c.first {
		switch {
		case b == '"':
			inQ = !inQ
		case !inQ && (b == ',' || b == ';' || b == '\t' || b == '|'):
			counts[b]++
		}
	}
	c.delim = ','
	best := counts[',']
	for _, d := range []byte{';', '\t', '|'} {
		if counts[d] > best {
			c.delim, best = d, counts[d]
		}
	}
	c.decided = true
	buf := c.first
	c.first = nil
	for _, b := range buf {
		c.b(b)
	}
}

func (c *csvScan) bytes(seg []byte) {
	if !c.decided {
		c.first = append(c.first, seg...)
		if len(c.first) >= c.opt.MaxLineAnalyze {
			c.decide()
		}
		return
	}
	for _, b := range seg {
		c.b(b)
	}
}

func (c *csvScan) add(x byte) {
	if c.collecting && len(c.field) < 4*c.opt.MaxHeaderNameLen {
		c.field = append(c.field, x)
	}
}

func (c *csvScan) endField() {
	c.fields++
	if c.collecting {
		if len(c.names) < c.opt.MaxHeaderNames {
			c.names = append(c.names, SanitizeName(strings.TrimSpace(string(c.field)), c.opt.MaxHeaderNameLen))
		} else {
			c.hdrTrunc = true
		}
		c.field = c.field[:0]
	}
	c.fieldStart = true
}

func (c *csvScan) b(x byte) {
	c.recBytes++
	if c.inQ {
		if c.quoteSeen {
			if x == '"' {
				c.quoteSeen = false
				c.add('"')
				return
			}
			c.inQ, c.quoteSeen = false, false
		} else {
			if x == '"' {
				c.quoteSeen = true
			} else {
				c.add(x)
			}
			return
		}
	}
	switch {
	case x == c.delim:
		c.endField()
	case x == '"' && c.fieldStart:
		c.inQ, c.fieldStart = true, false
	default:
		c.add(x)
		c.fieldStart = false
	}
}

func (c *csvScan) endLine() {
	if !c.decided {
		c.decide()
	}
	if c.inQ && c.quoteSeen {
		c.inQ, c.quoteSeen = false, false
	}
	if c.inQ { // newline inside a quoted field: the record continues on the next physical line
		c.add('\n')
		c.recBytes++
		return
	}
	if c.recBytes == 0 && c.fields == 0 {
		return // blank line
	}
	c.endField()
	c.records++
	if c.records == 1 {
		c.columns = c.fields
		c.collecting = false
	} else if c.fields != c.columns {
		c.ragged++
	}
	c.fields, c.recBytes, c.fieldStart = 0, 0, true
}

func (c *csvScan) result() *CSVInfo {
	if !c.decided {
		c.decide()
	}
	if c.recBytes > 0 || c.fields > 0 { // unterminated record at EOF
		c.inQ = false
		c.endLine()
	}
	name := map[byte]string{',': "comma", ';': "semicolon", '\t': "tab", '|': "pipe"}[c.delim]
	rows := c.records - 1
	if rows < 0 {
		rows = 0
	}
	names := c.names
	if names == nil {
		names = []string{}
	}
	return &CSVInfo{Delimiter: name, Columns: c.columns, HeaderNames: names, HeaderTruncated: c.hdrTrunc || c.columns > len(names), DataRows: rows, RaggedRows: c.ragged}
}
