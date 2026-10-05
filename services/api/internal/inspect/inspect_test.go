package inspect

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func run(t *testing.T, name string, data []byte, opt Options) *Result {
	t.Helper()
	h := sha256.Sum256(data)
	r, err := Run(context.Background(), Input{Name: name, Size: int64(len(data)), SHA256: hex.EncodeToString(h[:]), RA: bytes.NewReader(data)}, opt)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

type zf struct {
	name string
	data []byte
	mod  time.Time
}

func mkzip(t *testing.T, files ...zf) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, f := range files {
		h := &zip.FileHeader{Name: f.name, Method: zip.Deflate}
		if !f.mod.IsZero() {
			h.Modified = f.mod
		}
		fw, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write(f.data)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestTextLineCounts(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int64
	}{
		{"lf", "a\nb\nc\n", 3},
		{"crlf", "a\r\nb\r\nc\r\n", 3},
		{"no trailing newline", "a\nb\nc", 3},
		{"empty", "", 0},
		{"one blank", "\n", 1},
		{"mixed", "a\r\nb\nc", 3},
	}
	for _, c := range cases {
		r := run(t, "x.txt", []byte(c.in), Options{})
		if r.Manifest.Text == nil || r.Manifest.Text.Lines != c.want {
			t.Errorf("%s: lines = %+v, want %d", c.name, r.Manifest.Text, c.want)
		}
	}
	// CRLF split across the internal 32 KiB chunk boundary must still count once
	big := strings.Repeat("x", 32<<10-1) + "\r\n" + "tail\r\n"
	if r := run(t, "x.log", []byte(big), Options{}); r.Manifest.Text.Lines != 2 || r.Manifest.Text.MaxLineBytes != 32<<10-1 {
		t.Errorf("chunk boundary: %+v", r.Manifest.Text)
	}
}

func TestEncodings(t *testing.T) {
	r := run(t, "a.txt", append([]byte{0xEF, 0xBB, 0xBF}, "xin chào\nhai\n"...), Options{})
	if r.Manifest.Text.Encoding != "utf-8-bom" || r.Manifest.Text.Lines != 2 {
		t.Errorf("bom: %+v", r.Manifest.Text)
	}
	u := utf16.Encode([]rune("a,b\r\n1,2\r\n"))
	le := []byte{0xFF, 0xFE}
	be := []byte{0xFE, 0xFF}
	for _, x := range u {
		le = append(le, byte(x), byte(x>>8))
		be = append(be, byte(x>>8), byte(x))
	}
	for name, d := range map[string][]byte{"utf-16le": le, "utf-16be": be} {
		r := run(t, "a.csv", d, Options{})
		if r.Manifest.Text.Encoding != name || r.Manifest.Text.Lines != 2 || r.Manifest.Text.CSV == nil || r.Manifest.Text.CSV.Columns != 2 {
			t.Errorf("%s: %+v %+v", name, r.Manifest.Text, r.Manifest.Text.CSV)
		}
	}
	r = run(t, "a.txt", []byte("caf\xe9 au lait\nok\n"), Options{})
	if r.Manifest.Text.Encoding != "other" || r.Manifest.DetectedType != "txt" {
		t.Errorf("latin1: %+v", r.Manifest)
	}
}

func TestCSV(t *testing.T) {
	// BOM + CRLF + ragged + quoted newline + escaped quote
	in := "\xEF\xBB\xBFid,name,note\r\n1,An,\"line one\r\nline two\"\r\n2,\"Binh, B\",\"say \"\"hi\"\"\"\r\n3,Chi\r\n\r\n4,D,x,y\r\n"
	r := run(t, "people.csv", []byte(in), Options{})
	c := r.Manifest.Text.CSV
	if c == nil {
		t.Fatal("no csv info")
	}
	if c.Delimiter != "comma" || c.Columns != 3 || c.DataRows != 4 || c.RaggedRows != 2 {
		t.Errorf("csv = %+v", c)
	}
	if strings.Join(c.HeaderNames, "|") != "id|name|note" {
		t.Errorf("header = %v", c.HeaderNames)
	}
	if r.Manifest.Text.Lines != 7 { // physical lines (quoted newline counts)
		t.Errorf("lines = %d", r.Manifest.Text.Lines)
	}
	if r.Manifest.Text.Encoding != "utf-8-bom" {
		t.Errorf("enc = %s", r.Manifest.Text.Encoding)
	}
	// delimiter guesses
	if c := run(t, "d.csv", []byte("a;b;c\n1;2;3\n"), Options{}).Manifest.Text.CSV; c.Delimiter != "semicolon" || c.Columns != 3 {
		t.Errorf("semicolon %+v", c)
	}
	if c := run(t, "d.tsv", []byte("a\tb\n1\t2\n"), Options{}).Manifest.Text.CSV; c.Delimiter != "tab" || c.Columns != 2 {
		t.Errorf("tab %+v", c)
	}
	// header names are capped and truncated
	var hdr []string
	for i := 0; i < 100; i++ {
		hdr = append(hdr, strings.Repeat("h", 100))
	}
	c = run(t, "w.csv", []byte(strings.Join(hdr, ",")+"\n"), Options{}).Manifest.Text.CSV
	if c.Columns != 100 || len(c.HeaderNames) != 64 || !c.HeaderTruncated || len([]rune(c.HeaderNames[0])) > 65 {
		t.Errorf("cap: cols=%d names=%d trunc=%v len=%d", c.Columns, len(c.HeaderNames), c.HeaderTruncated, len(c.HeaderNames[0]))
	}
	// header only / empty
	if c := run(t, "h.csv", []byte("a,b\n"), Options{}).Manifest.Text.CSV; c.DataRows != 0 || c.Columns != 2 {
		t.Errorf("header-only %+v", c)
	}
	if c := run(t, "e.csv", nil, Options{}).Manifest.Text.CSV; c == nil || c.Columns != 0 {
		t.Errorf("empty %+v", c)
	}
}

func TestJSON(t *testing.T) {
	type tc struct {
		in      string
		valid   bool
		top     string
		length  int64
		errPart string
	}
	for _, c := range []tc{
		{`{"a":1,"b":[1,2,{"c":null}],"d":"x"}`, true, "object", 3, ""},
		{`[1,2,3,[4,5]]`, true, "array", 4, ""},
		{"  [ ]\n", true, "array", 0, ""},
		{`{}`, true, "object", 0, ""},
		{`"str"`, true, "string", 0, ""},
		{`12.5e3`, true, "number", 0, ""},
		{`true`, true, "boolean", 0, ""},
		{`{"a":1,}`, false, "object", 1, "key"},
		{`{"a":1`, false, "object", 1, "end"},
		{`[1 2]`, false, "array", 1, "expected"},
		{`{"a":01}`, false, "object", 1, "number"},
		{`[1,2] x`, false, "array", 2, "after"},
		{``, false, "", 0, "empty"},
		{`{"a":"\q"}`, false, "object", 1, "escape"},
		{`[tru]`, false, "array", 1, "literal"},
	} {
		r := run(t, "d.json", []byte(c.in), Options{})
		j := r.Manifest.Text.JSON
		if j == nil || j.Valid != c.valid || j.TopLevel != c.top || (c.valid && j.Length != c.length) {
			t.Errorf("%q: %+v", c.in, j)
			continue
		}
		if !c.valid && !strings.Contains(j.Error, c.errPart) {
			t.Errorf("%q: error %q lacks %q", c.in, j.Error, c.errPart)
		}
	}
	// deep nesting is bounded (no recursion, no memory)
	deep := strings.Repeat("[", 5000) + strings.Repeat("]", 5000)
	if j := run(t, "deep.json", []byte(deep), Options{}).Manifest.Text.JSON; j.Valid || !strings.Contains(j.Error, "nesting") {
		t.Errorf("deep: %+v", j)
	}
	ok := strings.Repeat("[", 500) + strings.Repeat("]", 500)
	if j := run(t, "ok.json", []byte(ok), Options{}).Manifest.Text.JSON; !j.Valid || j.MaxDepth != 500 {
		t.Errorf("500 deep: %+v", j)
	}
	// a huge array streams
	var b strings.Builder
	b.WriteString("[")
	for i := 0; i < 20000; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"id":1}`)
	}
	b.WriteString("]")
	if j := run(t, "big.json", []byte(b.String()), Options{}).Manifest.Text.JSON; !j.Valid || j.Length != 20000 {
		t.Errorf("big: %+v", j)
	}
}

func TestJSONL(t *testing.T) {
	in := "{\"a\":1}\n{\"b\":2}\r\n\nnot json\n[1,2]\n{\"c\":"
	for _, name := range []string{"x.jsonl", "x.ndjson"} {
		r := run(t, name, []byte(in), Options{})
		j := r.Manifest.Text.JSONL
		if j == nil || j.ValidLines != 3 || j.InvalidLines != 2 {
			t.Errorf("%s: %+v", name, j)
		}
		if r.Manifest.Text.Lines != 6 {
			t.Errorf("%s lines %d", name, r.Manifest.Text.Lines)
		}
	}
}

func TestSensitiveCountsOnly(t *testing.T) {
	in := "name,phone,mail,cccd,card\n" +
		"An,0912345678,an@example.com,012345678901,4111 1111 1111 1111\n" +
		"Binh,+84 987 654 321,b@x.vn,123456789,4111111111111112\n"
	r := run(t, "p.csv", []byte(in), Options{})
	s := r.Manifest.Sensitive
	if !r.Manifest.ContainsSensitivePatterns || s == nil {
		t.Fatalf("no sensitive: %+v", r.Manifest)
	}
	if s.Phone != 2 || s.Email != 2 || s.IDNumber != 2 || s.Card != 1 { // 4111…1112 fails Luhn
		t.Errorf("counts = %+v", *s)
	}
	// the manifest must not carry any of the values
	b := mustJSON(t, r)
	for _, secret := range []string{"0912345678", "an@example.com", "012345678901", "4111", "987 654"} {
		if strings.Contains(b, secret) {
			t.Errorf("manifest leaks %q", secret)
		}
	}
	if r := run(t, "clean.txt", []byte("hello world\n2024-01-01 12:00:00 ok\n"), Options{}); r.Manifest.ContainsSensitivePatterns {
		t.Errorf("false positive: %+v", r.Manifest.Sensitive)
	}
}

func TestBinaryAndExecutables(t *testing.T) {
	pe := append([]byte("MZ"), make([]byte, 200)...)
	r := run(t, "tool.exe", pe, Options{})
	if r.Manifest.DetectedType != "pe" || !r.Manifest.Executable || r.Manifest.TypeMismatch {
		t.Errorf("pe: %+v", r.Manifest)
	}
	// an executable renamed to .txt / .pdf is a mismatch
	for _, n := range []string{"notes.txt", "report.pdf"} {
		r = run(t, n, pe, Options{})
		if !r.Manifest.TypeMismatch || !r.Manifest.Executable || r.Manifest.MismatchNote == "" {
			t.Errorf("%s: %+v", n, r.Manifest)
		}
	}
	elf := append([]byte{0x7f, 'E', 'L', 'F'}, make([]byte, 100)...)
	if r := run(t, "a.out", elf, Options{}); r.Manifest.DetectedType != "elf" || !r.Manifest.Executable {
		t.Errorf("elf: %+v", r.Manifest)
	}
	macho := append([]byte{0xCF, 0xFA, 0xED, 0xFE}, make([]byte, 100)...)
	if r := run(t, "a", macho, Options{}); r.Manifest.DetectedType != "macho" || !r.Manifest.Executable {
		t.Errorf("macho: %+v", r.Manifest)
	}
	if r := run(t, "run.sh", []byte("#!/bin/sh\necho hi\n"), Options{}); r.Manifest.DetectedType != "script" || !r.Manifest.Executable || r.Manifest.TypeMismatch || r.Manifest.Text.Lines != 2 {
		t.Errorf("script: %+v", r.Manifest)
	}
	// plain binary: only type + size + sha
	bin := bytes.Repeat([]byte{0, 1, 2, 3, 0xff}, 100)
	r = run(t, "blob.dat", bin, Options{})
	if r.Manifest.DetectedType != "binary" || r.Manifest.Text != nil || r.Manifest.Zip != nil || r.Manifest.Size != 500 || r.Manifest.SHA256 == "" {
		t.Errorf("binary: %+v", r.Manifest)
	}
	// declared csv but it is a PNG
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 50)...)
	if r := run(t, "data.csv", png, Options{}); !r.Manifest.TypeMismatch || r.Manifest.DetectedType != "png" {
		t.Errorf("png.csv: %+v", r.Manifest)
	}
	// a .docx that is really text
	if r := run(t, "x.docx", []byte("just text"), Options{}); !r.Manifest.TypeMismatch {
		t.Errorf("docx text: %+v", r.Manifest)
	}
}

func TestZipBasic(t *testing.T) {
	mod := time.Date(2024, 5, 6, 7, 8, 10, 0, time.UTC)
	z := mkzip(t,
		zf{"data/people.csv", []byte("id,name\n1,An\n2,Binh\n"), mod},
		zf{"data/", nil, mod},
		zf{"cfg.json", []byte(`{"a":[1,2,3]}`), mod},
		zf{"note.txt", []byte("hello\nworld"), mod},
		zf{"bin/tool.exe", append([]byte("MZ"), make([]byte, 100)...), mod},
	)
	r := run(t, "bundle.zip", z, Options{})
	m := r.Manifest
	if m.DetectedType != "zip" || m.Label != "zip" || m.Zip == nil || m.Zip.EntryCount != 5 || m.Zip.FileCount != 4 || m.Zip.DirCount != 1 {
		t.Fatalf("manifest: %+v zip=%+v", m, m.Zip)
	}
	if !m.ContainsExecutable || m.Executable {
		t.Errorf("exec flags: %+v", m)
	}
	by := map[string]Entry{}
	for _, e := range r.Entries {
		by[e.Path] = e
	}
	csvE := by["data/people.csv"]
	if csvE.Lines == nil || *csvE.Lines != 3 || csvE.Rows == nil || *csvE.Rows != 2 || *csvE.Columns != 2 || csvE.SHA256 == "" || csvE.Size != 20 {
		t.Errorf("csv entry %+v", csvE)
	}
	if csvE.Modified != "2024-05-06T07:08:10Z" || len(csvE.CRC32) != 8 {
		t.Errorf("csv times %+v", csvE)
	}
	if by["note.txt"].Lines == nil || *by["note.txt"].Lines != 2 {
		t.Errorf("note: %+v", by["note.txt"])
	}
	if !by["data/"].IsDir {
		t.Errorf("dir: %+v", by["data/"])
	}
	exe := by["bin/tool.exe"]
	if !contains(exe.Flags, "executable") {
		t.Errorf("exe flags %v", exe.Flags)
	}
	// extension labels: xlsx is a zip, labelled by extension
	if r := run(t, "sheet.xlsx", z, Options{}); r.Manifest.Label != "xlsx" || r.Manifest.TypeMismatch {
		t.Errorf("xlsx label: %+v", r.Manifest)
	}
	// a zip renamed .pdf is a mismatch
	if r := run(t, "x.pdf", z, Options{}); !r.Manifest.TypeMismatch {
		t.Errorf("pdf mismatch: %+v", r.Manifest)
	}
	for i, e := range r.Entries {
		if e.Idx != i {
			t.Errorf("idx %d != %d", e.Idx, i)
		}
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestZipSlipAndHugeNames(t *testing.T) {
	long := strings.Repeat("a", 5000) + ".txt"
	z := mkzip(t,
		zf{"../../etc/passwd", []byte("x"), time.Time{}},
		zf{"/abs/path.txt", []byte("x"), time.Time{}},
		zf{"C:\\Windows\\evil.dll", []byte("x"), time.Time{}},
		zf{"a/../../b", []byte("x"), time.Time{}},
		zf{"ok/file.txt", []byte("x"), time.Time{}},
		zf{"evil\r\nINJECT forged log line\x00.txt", []byte("x"), time.Time{}},
		zf{"rtl\u202egnp.exe", []byte("x"), time.Time{}},
		zf{long, []byte("x"), time.Time{}},
	)
	r := run(t, "slip.zip", z, Options{})
	if r.Manifest.Zip.ZipSlipCount != 5 {
		t.Errorf("slip count %d", r.Manifest.Zip.ZipSlipCount)
	}
	for _, e := range r.Entries {
		if strings.ContainsAny(e.Path, "\r\n\x00\u202e") {
			t.Errorf("unsafe chars survive in %q", e.Path)
		}
		if len([]rune(e.Path)) > 513 {
			t.Errorf("name not capped: %d", len([]rune(e.Path)))
		}
	}
	slip := 0
	for _, e := range r.Entries {
		if e.ZipSlip && contains(e.Flags, "zip-slip") {
			slip++
		}
	}
	if slip != 5 {
		t.Errorf("flagged %d", slip)
	}
}

func TestZipEmptyAndInvalid(t *testing.T) {
	r := run(t, "empty.zip", mkzip(t), Options{})
	if r.Manifest.DetectedType != "zip" || r.Manifest.Zip == nil || r.Manifest.Zip.EntryCount != 0 || len(r.Entries) != 0 || r.Manifest.Truncated {
		t.Errorf("empty: %+v %+v", r.Manifest, r.Manifest.Zip)
	}
	// starts like a zip but is cut: parseError, no panic, no failure of Run
	z := mkzip(t, zf{"a.txt", bytes.Repeat([]byte("x"), 500), time.Time{}})
	r = run(t, "cut.zip", z[:len(z)/2], Options{})
	if r.Manifest.ParseError == "" {
		t.Errorf("expected parseError: %+v", r.Manifest)
	}
	// garbage with a PK header
	r = run(t, "junk.zip", append([]byte("PK\x03\x04"), bytes.Repeat([]byte{7}, 300)...), Options{})
	if r.Manifest.ParseError == "" {
		t.Errorf("junk: %+v", r.Manifest)
	}
}

func TestZipEntryCapAndBudget(t *testing.T) {
	var files []zf
	for i := 0; i < 50; i++ {
		files = append(files, zf{name: "f" + string(rune('A'+i%26)) + strings.Repeat("x", i) + ".txt", data: []byte("a\nb\n")})
	}
	z := mkzip(t, files...)
	r := run(t, "many.zip", z, Options{MaxEntries: 10})
	if len(r.Entries) != 10 || !r.Manifest.Truncated || !strings.Contains(r.Manifest.TruncatedReason, "entry-cap") || r.Manifest.Zip.EntryCount != 50 {
		t.Errorf("entry cap: n=%d %+v", len(r.Entries), r.Manifest)
	}
	// byte budget: entries beyond the budget are listed but not read
	big := bytes.Repeat([]byte("line\n"), 20000) // 100 KB each
	z = mkzip(t, zf{name: "a.txt", data: big}, zf{name: "b.txt", data: big}, zf{name: "c.txt", data: big})
	r = run(t, "budget.zip", z, Options{MaxTotalBytes: 150 << 10})
	if !r.Manifest.Truncated || !strings.Contains(r.Manifest.TruncatedReason, "byte-budget") || len(r.Entries) != 3 {
		t.Errorf("budget: %+v n=%d", r.Manifest, len(r.Entries))
	}
	if r.Entries[0].Lines == nil || *r.Entries[0].Lines != 20000 {
		t.Errorf("first entry should be fully read: %+v", r.Entries[0])
	}
	// top-level text file over budget
	r = run(t, "huge.log", bytes.Repeat([]byte("0123456789\n"), 100000), Options{MaxTotalBytes: 100000})
	if !r.Manifest.Truncated || r.Manifest.TruncatedReason != "byte-budget" || r.Manifest.Text.Lines == 0 || r.Manifest.Text.Lines >= 100000 {
		t.Errorf("text budget: %+v %+v", r.Manifest, r.Manifest.Text)
	}
}

func TestZipBombRatio(t *testing.T) {
	zeros := make([]byte, 8<<20) // 8 MiB of zeros compresses ~1000:1
	z := mkzip(t, zf{name: "bomb.bin", data: zeros}, zf{name: "ok.txt", data: []byte("fine\n")})
	r := run(t, "bomb.zip", z, Options{MaxRatio: 100})
	b := r.Entries[0]
	if !contains(b.Flags, "bomb-ratio") || b.SHA256 != "" || !r.Manifest.Truncated || !strings.Contains(r.Manifest.TruncatedReason, "ratio-cap") {
		t.Errorf("bomb: %+v %+v", b, r.Manifest)
	}
	if r.Entries[1].Lines == nil {
		t.Errorf("later entries are still inspected: %+v", r.Entries[1])
	}
	if r.Manifest.Zip.MaxRatio < 100 {
		t.Errorf("max ratio %f", r.Manifest.Zip.MaxRatio)
	}
}

func TestZipTimeout(t *testing.T) {
	var files []zf
	for i := 0; i < 20; i++ {
		files = append(files, zf{name: strings.Repeat("n", i+1), data: bytes.Repeat([]byte("x\n"), 1000)})
	}
	z := mkzip(t, files...)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, err := Run(ctx, Input{Name: "t.zip", Size: int64(len(z)), RA: bytes.NewReader(z)}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Manifest.Truncated || !strings.Contains(res.Manifest.TruncatedReason, "timeout") {
		t.Errorf("timeout: %+v", res.Manifest)
	}
}

func TestZipEncryptedEntries(t *testing.T) {
	// craft a raw entry whose "encrypted" general purpose bit is set (data is not decryptable and must not be read)
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	h := &zip.FileHeader{Name: "secret.docx", Method: zip.Store, Flags: 0x1, CompressedSize64: 12, UncompressedSize64: 4, CRC32: 1}
	fw, err := w.CreateRaw(h)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(make([]byte, 12))
	h2 := &zip.FileHeader{Name: "aes.bin", Method: 99, CompressedSize64: 8, UncompressedSize64: 3}
	fw, _ = w.CreateRaw(h2)
	_, _ = fw.Write(make([]byte, 8))
	fw, _ = w.CreateHeader(&zip.FileHeader{Name: "plain.txt", Method: zip.Deflate})
	_, _ = fw.Write([]byte("plain\n"))
	_ = w.Close()
	r := run(t, "enc.zip", b.Bytes(), Options{})
	if r.Manifest.Zip.EncryptedCount != 2 || len(r.Entries) != 3 {
		t.Fatalf("enc: %+v n=%d", r.Manifest.Zip, len(r.Entries))
	}
	for _, e := range r.Entries[:2] {
		if !e.Encrypted || !contains(e.Flags, "encrypted") || e.SHA256 != "" || e.Lines != nil {
			t.Errorf("encrypted entry inspected: %+v", e)
		}
	}
	if r.Entries[2].Lines == nil {
		t.Errorf("plain entry not inspected")
	}
}

func TestZipNested(t *testing.T) {
	inner := mkzip(t, zf{name: "deep.csv", data: []byte("a,b\n1,2\n")}, zf{name: "x/y.txt", data: []byte("one\ntwo\nthree\n")})
	lvl2 := mkzip(t, zf{name: "lvl3.zip", data: mkzip(t, zf{name: "too-deep.txt", data: []byte("z")})})
	outer := mkzip(t, zf{name: "inner.zip", data: inner}, zf{name: "lvl2.zip", data: lvl2}, zf{name: "top.txt", data: []byte("t\n")})
	r := run(t, "outer.zip", outer, Options{}) // MaxDepth 2
	by := map[string]Entry{}
	for _, e := range r.Entries {
		by[e.Path] = e
	}
	if !by["inner.zip"].Nested || by["inner.zip"].Depth != 1 {
		t.Errorf("inner: %+v", by["inner.zip"])
	}
	d := by["inner.zip!/deep.csv"]
	if d.Depth != 2 || d.Lines == nil || *d.Lines != 2 || d.Rows == nil || *d.Rows != 1 {
		t.Errorf("nested csv: %+v", d)
	}
	if e := by["inner.zip!/x/y.txt"]; e.Lines == nil || *e.Lines != 3 {
		t.Errorf("nested txt: %+v", e)
	}
	l3 := by["lvl2.zip!/lvl3.zip"]
	if !l3.Nested || l3.Depth != 2 {
		t.Errorf("lvl3 recorded, not opened: %+v", l3)
	}
	if _, ok := by["lvl2.zip!/lvl3.zip!/too-deep.txt"]; ok {
		t.Errorf("must not open depth 3")
	}
	if r.Manifest.Zip.NestedArchiveCount != 3 || !r.Manifest.Truncated || !strings.Contains(r.Manifest.TruncatedReason, "nested-depth") {
		t.Errorf("summary: %+v", r.Manifest)
	}
	// depth 1 only: nested archive listed but not opened
	r = run(t, "outer.zip", outer, Options{MaxDepth: 1})
	for _, e := range r.Entries {
		if strings.Contains(e.Path, "!/") {
			t.Errorf("opened nested archive with MaxDepth=1: %s", e.Path)
		}
	}
}

func TestZipSensitiveRollup(t *testing.T) {
	z := mkzip(t, zf{name: "c.csv", data: []byte("phone\n0912345678\n0987654321\n")}, zf{name: "n.txt", data: []byte("nothing\n")})
	r := run(t, "s.zip", z, Options{})
	if !r.Manifest.ContainsSensitivePatterns || r.Manifest.Sensitive.Phone != 2 {
		t.Errorf("rollup: %+v", r.Manifest.Sensitive)
	}
	if !contains(r.Entries[0].Flags, "sensitive") || contains(r.Entries[1].Flags, "sensitive") {
		t.Errorf("flags: %v %v", r.Entries[0].Flags, r.Entries[1].Flags)
	}
}

func TestSanitizeName(t *testing.T) {
	if got := SanitizeName("a\r\nb\x00c\u202ed", 100); got != "abcd" {
		t.Errorf("got %q", got)
	}
	if got := SanitizeName(strings.Repeat("é", 10), 4); got != "éééé…" {
		t.Errorf("got %q", got)
	}
	if got := SanitizeName("bad\xffutf8", 100); got != "bad?utf8" {
		t.Errorf("got %q", got)
	}
}

func TestExt(t *testing.T) {
	for in, want := range map[string]string{"a.CSV": "csv", "a.tar.gz": "gz", "noext": "", "dir\\x.TXT": "txt", ".hidden": "hidden"} {
		if got := Ext(in); got != want {
			t.Errorf("Ext(%q) = %q want %q", in, got, want)
		}
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := jsonMarshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
