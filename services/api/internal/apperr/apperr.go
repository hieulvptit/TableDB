// Package apperr holds the API error type. Codes and HTTP statuses mirror services/api/src/errors.ts.
package apperr

import (
	"errors"
	"fmt"
)

type Code string

const (
	Forbidden       Code = "FORBIDDEN"
	Unauthenticated Code = "UNAUTHENTICATED"
	NotFoundCode    Code = "NOT_FOUND"
	ValidationCode  Code = "VALIDATION"
	ConflictCode    Code = "CONFLICT"
	RateLimited     Code = "RATE_LIMITED"
	Upstream        Code = "UPSTREAM"
	Internal        Code = "INTERNAL"
	StepupRequired  Code = "STEPUP_REQUIRED"
	// InsufficientStorage: the server disk budget (DISK_MAX_USED_PCT) is exhausted; new uploads are refused (HTTP 507).
	InsufficientStorage Code = "INSUFFICIENT_STORAGE"
)

var status = map[Code]int{
	Forbidden: 403, Unauthenticated: 401, NotFoundCode: 404, ValidationCode: 400, ConflictCode: 409,
	RateLimited: 429, Upstream: 502, Internal: 500, StepupRequired: 401, InsufficientStorage: 507,
}

// Error is an expected, client-visible failure.
type Error struct {
	Code    Code
	Message string
	Details any
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Status is the HTTP status for the code.
func (e *Error) Status() int { return status[e.Code] }

func New(code Code, msg string) *Error { return &Error{Code: code, Message: msg} }

func Forbiddenf(format string, a ...any) *Error {
	return &Error{Code: Forbidden, Message: fmt.Sprintf(format, a...)}
}
func NewForbidden(m string) *Error { return &Error{Code: Forbidden, Message: m} }
func NotFound(m string) *Error     { return &Error{Code: NotFoundCode, Message: m} }
func Validation(m string) *Error   { return &Error{Code: ValidationCode, Message: m} }
func ValidationD(m string, d any) *Error {
	return &Error{Code: ValidationCode, Message: m, Details: d}
}
func Conflict(m string) *Error { return &Error{Code: ConflictCode, Message: m} }
func ConflictD(m string, d any) *Error {
	return &Error{Code: ConflictCode, Message: m, Details: d}
}
func Unauth(m string) *Error      { return &Error{Code: Unauthenticated, Message: m} }
func NewUpstream(m string) *Error { return &Error{Code: Upstream, Message: m} }
func NewInternal(m string) *Error { return &Error{Code: Internal, Message: m} }

// Is reports whether err is an *Error with the given code.
func Is(err error, c Code) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == c
}
