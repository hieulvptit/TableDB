package shared

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
)

// Issue mirrors a zod issue ({path,message}) in the 400 VALIDATION details.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ValidationError is returned by the hand-written validators.
type ValidationError struct{ Issues []Issue }

func (e *ValidationError) Error() string {
	var parts []string
	for _, i := range e.Issues {
		parts = append(parts, i.Path+": "+i.Message)
	}
	return "invalid request: " + strings.Join(parts, "; ")
}

var (
	uuidRe   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// IsUUID is the (version-agnostic) uuid check zod applies.
func IsUUID(s string) bool { return uuidRe.MatchString(s) }

// Obj is a decoded JSON object with accumulating, zod-style field validation.
type Obj struct {
	m      map[string]any
	Issues []Issue
}

// DecodeObject parses a JSON body. nil/empty body or a non-object yields an Obj with an issue (like zod on undefined).
func DecodeObject(body []byte) *Obj {
	o := &Obj{m: map[string]any{}}
	if len(bytes.TrimSpace(body)) == 0 {
		o.Issues = append(o.Issues, Issue{"", "Required"})
		return o
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		o.Issues = append(o.Issues, Issue{"", "Invalid JSON"})
		return o
	}
	m, ok := v.(map[string]any)
	if !ok {
		o.Issues = append(o.Issues, Issue{"", "Expected object"})
		return o
	}
	o.m = m
	return o
}

func (o *Obj) bad(path, msg string) { o.Issues = append(o.Issues, Issue{path, msg}) }

func (o *Obj) Has(k string) bool { _, ok := o.m[k]; return ok }

// Raw returns the underlying value (nil if absent).
func (o *Obj) Raw(k string) any { return o.m[k] }

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// String reads a string field. required=false returns ("", false) when absent.
func (o *Obj) String(k string, required bool, min, max int) (string, bool) {
	v, present := o.m[k]
	if !present || v == nil {
		if required {
			o.bad(k, "Required")
		}
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		o.bad(k, "Expected string")
		return "", false
	}
	n := utf16Len(s)
	if min > 0 && n < min {
		o.bad(k, fmt.Sprintf("String must contain at least %d character(s)", min))
	}
	if max > 0 && n > max {
		o.bad(k, fmt.Sprintf("String must contain at most %d character(s)", max))
	}
	return s, true
}

func (o *Obj) Enum(k string, required bool, allowed ...string) (string, bool) {
	s, ok := o.String(k, required, 0, 0)
	if !ok {
		return "", false
	}
	for _, a := range allowed {
		if a == s {
			return s, true
		}
	}
	o.bad(k, "Invalid enum value. Expected "+strings.Join(allowed, " | "))
	return "", false
}

func (o *Obj) UUID(k string, required bool) (string, bool) {
	s, ok := o.String(k, required, 0, 0)
	if ok && !IsUUID(s) {
		o.bad(k, "Invalid uuid")
		return "", false
	}
	return s, ok
}

// Int reads an integer within [min,max] (set hasMax=false for unbounded).
func (o *Obj) Int(k string, required bool, min int64, max int64, hasMax bool) (int64, bool) {
	v, present := o.m[k]
	if !present || v == nil {
		if required {
			o.bad(k, "Required")
		}
		return 0, false
	}
	n, ok := v.(json.Number)
	if !ok {
		o.bad(k, "Expected number")
		return 0, false
	}
	f, err := n.Float64()
	if err != nil || math.IsInf(f, 0) {
		o.bad(k, "Expected number")
		return 0, false
	}
	if f != math.Trunc(f) {
		o.bad(k, "Expected integer, received float")
		return 0, false
	}
	if f < float64(min) {
		o.bad(k, fmt.Sprintf("Number must be greater than or equal to %d", min))
		return 0, false
	}
	if hasMax && f > float64(max) {
		o.bad(k, fmt.Sprintf("Number must be less than or equal to %d", max))
		return 0, false
	}
	if f > 9007199254740991 {
		o.bad(k, "Number too large")
		return 0, false
	}
	return int64(f), true
}

func (o *Obj) Bool(k string, required bool) (bool, bool) {
	v, present := o.m[k]
	if !present || v == nil {
		if required {
			o.bad(k, "Required")
		}
		return false, false
	}
	b, ok := v.(bool)
	if !ok {
		o.bad(k, "Expected boolean")
		return false, false
	}
	return b, true
}

// Sub validates a nested object field.
func (o *Obj) Sub(k string) (*Obj, bool) {
	v, present := o.m[k]
	if !present || v == nil {
		return nil, false
	}
	m, ok := v.(map[string]any)
	if !ok {
		o.bad(k, "Expected object")
		return nil, false
	}
	return &Obj{m: m}, true
}

// Merge copies a nested object's issues into the parent, prefixing the path.
func (o *Obj) Merge(prefix string, sub *Obj) {
	for _, i := range sub.Issues {
		p := prefix
		if i.Path != "" {
			p += "." + i.Path
		}
		o.Issues = append(o.Issues, Issue{p, i.Message})
	}
}

// Err returns a *ValidationError when any issue was recorded.
func (o *Obj) Err() error {
	if len(o.Issues) == 0 {
		return nil
	}
	return &ValidationError{Issues: o.Issues}
}

// ---- DTOs

type UploadInit struct {
	FileName     string
	Size         int64
	SHA256       string
	Purpose      string
	ApproverID   string
	RecipientIDs []string
}

// ParseUploadInit mirrors the zod UploadInit schema (unknown keys, e.g. direction, are ignored).
func ParseUploadInit(body []byte) (*UploadInit, error) {
	o := DecodeObject(body)
	if len(o.Issues) > 0 {
		return nil, o.Err()
	}
	u := &UploadInit{RecipientIDs: []string{}}
	u.FileName, _ = o.String("fileName", true, 1, 255)
	u.Size, _ = o.Int("size", true, 1, 0, false)
	if s, ok := o.String("sha256", true, 0, 0); ok {
		if !sha256Re.MatchString(s) {
			o.bad("sha256", "Invalid")
		}
		u.SHA256 = s
	}
	u.Purpose, _ = o.String("purpose", true, 5, 1000)
	u.ApproverID, _ = o.UUID("approverId", true)
	if v, present := o.m["recipientIds"]; present && v != nil {
		arr, ok := v.([]any)
		if !ok {
			o.bad("recipientIds", "Expected array")
		} else {
			if len(arr) > 20 {
				o.bad("recipientIds", "Array must contain at most 20 element(s)")
			}
			for i, e := range arr {
				s, ok := e.(string)
				if !ok || !IsUUID(s) {
					o.bad(fmt.Sprintf("recipientIds.%d", i), "Invalid uuid")
					continue
				}
				u.RecipientIDs = append(u.RecipientIDs, s)
			}
		}
	}
	if err := o.Err(); err != nil {
		return nil, err
	}
	return u, nil
}

type DecisionBody struct {
	Decision string
	Reason   *string
}

func ParseDecisionBody(body []byte) (*DecisionBody, error) {
	o := DecodeObject(body)
	if len(o.Issues) > 0 {
		return nil, o.Err()
	}
	d := &DecisionBody{}
	d.Decision, _ = o.Enum("decision", true, "approve", "reject")
	if r, ok := o.String("reason", false, 0, 1000); ok {
		d.Reason = &r
	}
	if err := o.Err(); err != nil {
		return nil, err
	}
	if d.Decision == "reject" && (d.Reason == nil || utf16Len(strings.TrimSpace(*d.Reason)) < 3) {
		return nil, &ValidationError{Issues: []Issue{{"reason", "reason required when rejecting"}}}
	}
	return d, nil
}
