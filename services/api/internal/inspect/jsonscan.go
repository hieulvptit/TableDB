package inspect

import "fmt"

// jsonScan is a byte-fed JSON validator with O(depth) memory: it never builds a value, so a multi-GB document or a
// 1 GB string costs nothing. It records the top-level kind, the number of top-level elements/keys and the max depth.
type jsonScan struct {
	maxDepthAllowed int
	stack           []byte // 'o' or 'a'
	st              int
	strKey          bool
	esc             bool
	hex             int
	lit             string
	num             []byte
	started         bool
	done            bool
	err             string
	off             int64

	TopLevel string
	Length   int64
	MaxDepth int
}

const (
	jsValue = iota // expecting a value
	jsObjKeyOrEnd
	jsObjKey
	jsColon
	jsAfter
	jsArrValueOrEnd
	jsStr
	jsLit
	jsNum
)

func newJSONScan(maxDepth int) *jsonScan {
	if maxDepth <= 0 {
		maxDepth = 1000
	}
	return &jsonScan{maxDepthAllowed: maxDepth}
}

func (j *jsonScan) Reset() {
	*j = jsonScan{maxDepthAllowed: j.maxDepthAllowed, stack: j.stack[:0]}
}

func (j *jsonScan) fail(format string, a ...any) {
	if j.err == "" {
		j.err = fmt.Sprintf(format, a...) + fmt.Sprintf(" (at byte %d)", j.off)
	}
}

func isWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func (j *jsonScan) topKind(k string) {
	if len(j.stack) == 0 && j.TopLevel == "" {
		j.TopLevel = k
	}
}

// elementStart counts an element/key directly under the top-level container.
func (j *jsonScan) elementStart() {
	if len(j.stack) == 1 {
		j.Length++
	}
}

func (j *jsonScan) valueDone() {
	if len(j.stack) == 0 {
		j.done = true
		j.st = jsAfter
		return
	}
	j.st = jsAfter
}

func (j *jsonScan) beginValue(c byte) {
	switch {
	case c == '{':
		j.topKind("object")
		if len(j.stack) >= j.maxDepthAllowed {
			j.fail("nesting deeper than %d", j.maxDepthAllowed)
			return
		}
		j.stack = append(j.stack, 'o')
		if len(j.stack) > j.MaxDepth {
			j.MaxDepth = len(j.stack)
		}
		j.st = jsObjKeyOrEnd
	case c == '[':
		j.topKind("array")
		if len(j.stack) >= j.maxDepthAllowed {
			j.fail("nesting deeper than %d", j.maxDepthAllowed)
			return
		}
		j.stack = append(j.stack, 'a')
		if len(j.stack) > j.MaxDepth {
			j.MaxDepth = len(j.stack)
		}
		j.st = jsArrValueOrEnd
	case c == '"':
		j.topKind("string")
		j.strKey = false
		j.st, j.esc, j.hex = jsStr, false, 0
	case c == 't':
		j.topKind("boolean")
		j.lit, j.st = "rue", jsLit
	case c == 'f':
		j.topKind("boolean")
		j.lit, j.st = "alse", jsLit
	case c == 'n':
		j.topKind("null")
		j.lit, j.st = "ull", jsLit
	case c == '-' || (c >= '0' && c <= '9'):
		j.topKind("number")
		j.num = append(j.num[:0], c)
		j.st = jsNum
	default:
		j.fail("unexpected character where a value is expected")
	}
}

func validNumber(b []byte) bool {
	i := 0
	if i < len(b) && b[i] == '-' {
		i++
	}
	if i >= len(b) {
		return false
	}
	if b[i] == '0' {
		i++
	} else if b[i] >= '1' && b[i] <= '9' {
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
	} else {
		return false
	}
	if i < len(b) && b[i] == '.' {
		i++
		s := i
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
		if i == s {
			return false
		}
	}
	if i < len(b) && (b[i] == 'e' || b[i] == 'E') {
		i++
		if i < len(b) && (b[i] == '+' || b[i] == '-') {
			i++
		}
		s := i
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
		if i == s {
			return false
		}
	}
	return i == len(b)
}

func (j *jsonScan) endNumber() {
	if !validNumber(j.num) {
		j.fail("invalid number")
	}
	j.valueDone()
}

// Write feeds bytes; after the first error everything is ignored.
func (j *jsonScan) Write(p []byte) {
	for _, c := range p {
		if j.err != "" {
			return
		}
		j.off++
		j.step(c)
	}
}

func (j *jsonScan) step(c byte) {
	switch j.st {
	case jsNum:
		if (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
			if len(j.num) > 400 {
				j.fail("number too long")
				return
			}
			j.num = append(j.num, c)
			return
		}
		j.endNumber()
		if j.err != "" {
			return
		}
		j.step(c) // re-process the delimiter in jsAfter
		return
	case jsStr:
		switch {
		case j.hex > 0:
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				j.fail("bad unicode escape")
				return
			}
			j.hex--
		case j.esc:
			j.esc = false
			switch c {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			case 'u':
				j.hex = 4
			default:
				j.fail("bad escape")
			}
		case c == '\\':
			j.esc = true
		case c == '"':
			if j.strKey {
				j.st = jsColon
			} else {
				j.valueDone()
			}
		case c < 0x20:
			j.fail("control character in string")
		}
		return
	case jsLit:
		if len(j.lit) == 0 || c != j.lit[0] {
			j.fail("invalid literal")
			return
		}
		j.lit = j.lit[1:]
		if len(j.lit) == 0 {
			j.valueDone()
		}
		return
	}
	if isWS(c) {
		return
	}
	if j.done {
		j.fail("data after the top-level value")
		return
	}
	switch j.st {
	case jsValue:
		j.started = true
		if len(j.stack) == 1 && j.stack[0] == 'a' {
			j.Length++ // element after a comma
		}
		j.beginValue(c)
	case jsArrValueOrEnd:
		if c == ']' {
			j.pop()
			return
		}
		j.elementStart()
		j.beginValue(c)
	case jsObjKeyOrEnd:
		if c == '}' {
			j.pop()
			return
		}
		fallthrough
	case jsObjKey:
		if c != '"' {
			j.fail("object key must be a string")
			return
		}
		j.elementStart()
		j.strKey, j.st, j.esc, j.hex = true, jsStr, false, 0
	case jsColon:
		if c != ':' {
			j.fail("expected ':'")
			return
		}
		j.st = jsValue
	case jsAfter:
		if len(j.stack) == 0 {
			j.fail("data after the top-level value")
			return
		}
		top := j.stack[len(j.stack)-1]
		switch {
		case c == ',' && top == 'a':
			j.st = jsValue
		case c == ',' && top == 'o':
			j.st = jsObjKey
		case c == ']' && top == 'a', c == '}' && top == 'o':
			j.pop()
		default:
			j.fail("expected ',' or closing bracket")
		}
	}
}

func (j *jsonScan) pop() {
	j.stack = j.stack[:len(j.stack)-1]
	j.valueDone()
}

// Finish reports validity at end of input.
func (j *jsonScan) Finish() (ok bool, errMsg string) {
	if j.err != "" {
		return false, j.err
	}
	if j.st == jsNum {
		j.endNumber()
		if j.err != "" {
			return false, j.err
		}
	}
	if !j.started {
		return false, "empty document"
	}
	if !j.done || len(j.stack) != 0 || j.st == jsStr || j.st == jsLit {
		return false, "unexpected end of input"
	}
	return true, ""
}
