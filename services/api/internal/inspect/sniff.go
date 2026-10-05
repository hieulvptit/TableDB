package inspect

import (
	"bytes"
	"path"
	"strings"
	"unicode/utf8"
)

// Families group extensions / detected types so a declared extension can be compared with what the bytes really are.
var zipExts = map[string]bool{"zip": true, "jar": true, "war": true, "docx": true, "xlsx": true, "pptx": true, "odt": true, "ods": true, "odp": true, "apk": true, "epub": true, "xlsm": true, "docm": true}
var textExts = map[string]bool{"csv": true, "tsv": true, "txt": true, "log": true, "json": true, "jsonl": true, "ndjson": true, "xml": true, "sql": true, "md": true,
	"yml": true, "yaml": true, "ini": true, "conf": true, "cfg": true, "html": true, "htm": true, "js": true, "ts": true, "py": true, "sh": true, "bat": true, "cmd": true, "ps1": true, "properties": true, "toml": true}
var execExts = map[string]bool{"exe": true, "dll": true, "sys": true, "scr": true, "msi": true, "com": true, "so": true, "dylib": true, "bin": true, "elf": true}

// Ext returns the lower-case extension without the dot ("" if none).
func Ext(name string) string {
	e := strings.ToLower(path.Ext(strings.ReplaceAll(name, "\\", "/")))
	return strings.TrimPrefix(e, ".")
}

// sniffKind identifies the real type from the first bytes. text means "looks like text" (the caller refines by extension).
func sniffKind(head []byte) string {
	h := head
	switch {
	case bytes.HasPrefix(h, []byte("PK\x03\x04")), bytes.HasPrefix(h, []byte("PK\x05\x06")), bytes.HasPrefix(h, []byte("PK\x07\x08")):
		return "zip"
	case bytes.HasPrefix(h, []byte{0x1f, 0x8b}):
		return "gzip"
	case bytes.HasPrefix(h, []byte{'7', 'z', 0xBC, 0xAF, 0x27, 0x1C}):
		return "7z"
	case bytes.HasPrefix(h, []byte("Rar!\x1a\x07")):
		return "rar"
	case bytes.HasPrefix(h, []byte("%PDF-")):
		return "pdf"
	case bytes.HasPrefix(h, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(h, []byte{0xFF, 0xD8, 0xFF}):
		return "jpeg"
	case bytes.HasPrefix(h, []byte("GIF87a")), bytes.HasPrefix(h, []byte("GIF89a")):
		return "gif"
	case bytes.HasPrefix(h, []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}):
		return "ole"
	case bytes.HasPrefix(h, []byte("MZ")) && len(h) >= 64:
		return "pe"
	case bytes.HasPrefix(h, []byte{0x7f, 'E', 'L', 'F'}):
		return "elf"
	case bytes.HasPrefix(h, []byte{0xFE, 0xED, 0xFA, 0xCE}), bytes.HasPrefix(h, []byte{0xFE, 0xED, 0xFA, 0xCF}),
		bytes.HasPrefix(h, []byte{0xCE, 0xFA, 0xED, 0xFE}), bytes.HasPrefix(h, []byte{0xCF, 0xFA, 0xED, 0xFE}),
		bytes.HasPrefix(h, []byte{0xCA, 0xFE, 0xBA, 0xBE}):
		return "macho"
	case bytes.HasPrefix(h, []byte("#!")):
		return "script"
	}
	if looksText(h) {
		return "text"
	}
	return "binary"
}

func isExecutableKind(k string) bool { return k == "pe" || k == "elf" || k == "macho" || k == "script" }

// textEncoding classifies a text head; ok=false when the bytes are not text.
func looksText(h []byte) bool {
	if len(h) == 0 {
		return true
	}
	if bytes.HasPrefix(h, []byte{0xFF, 0xFE}) || bytes.HasPrefix(h, []byte{0xFE, 0xFF}) {
		return true
	}
	if bytes.HasPrefix(h, []byte{0xEF, 0xBB, 0xBF}) {
		h = h[3:]
	}
	if bytes.IndexByte(h, 0) >= 0 {
		return false
	}
	bad := 0
	i := 0
	for i < len(h) {
		r, sz := utf8.DecodeRune(h[i:])
		if r == utf8.RuneError && sz == 1 {
			// an incomplete rune at the very end of the head is fine
			if !utf8.FullRune(h[i:]) {
				break
			}
			bad++
		} else if r < 0x20 && r != '\n' && r != '\r' && r != '\t' && r != '\f' && r != 0x1b {
			bad++
		}
		i += sz
	}
	// legacy 8-bit text (Windows-1258 …) is still text: tolerate some high bytes, not control characters
	return bad*20 < len(h)+20
}

// familyOfExt returns the type family a declared extension promises ("" = unknown/no promise).
func familyOfExt(ext string) string {
	switch {
	case zipExts[ext]:
		return "zip"
	case textExts[ext]:
		return "text"
	case execExts[ext]:
		return "exec"
	}
	switch ext {
	case "gz", "tgz":
		return "gzip"
	case "7z":
		return "7z"
	case "rar":
		return "rar"
	case "pdf":
		return "pdf"
	case "png":
		return "png"
	case "jpg", "jpeg":
		return "jpeg"
	case "gif":
		return "gif"
	case "doc", "xls", "ppt", "msg":
		return "ole"
	}
	return ""
}

func familyOfKind(k string) string {
	switch k {
	case "pe", "elf", "macho":
		return "exec"
	case "script":
		return "text"
	}
	return k
}

// mismatch compares the declared extension with the sniffed kind.
func mismatch(ext, kind string) (bool, string) {
	decl := familyOfExt(ext)
	real := familyOfKind(kind)
	if isExecutableKind(kind) && kind != "script" && decl != "exec" {
		return true, "content is an executable (" + kind + ") but the extension is ." + ext
	}
	if decl == "" || decl == real {
		return false, ""
	}
	if decl == "text" && kind == "script" {
		return false, ""
	}
	if decl == "exec" && (real == "text" || real == "binary") {
		return false, "" // e.g. .bin/.so of unknown format
	}
	return true, "extension ." + ext + " suggests " + decl + " but content looks like " + kind
}
