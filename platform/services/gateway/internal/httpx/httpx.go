// Package httpx is the gateway's HTTP conventions: how a response is shaped,
// how an error is reported, and how every request is identified in the log.
//
// The frontend reads `code` to decide what to do, so these strings are part of
// the contract and must not drift.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

type ErrorBody struct {
	Code        string       `json:"code"`
	Message     string       `json:"message"`
	FieldErrors []FieldError `json:"fieldErrors,omitempty"`
	RequestID   string       `json:"requestId,omitempty"`
}

// Codes the frontend branches on. Anything else is treated as unknown.
const (
	CodeUnauthenticated = "unauthenticated"
	CodeNotEntitled     = "not_entitled"
	CodeForbidden       = "forbidden"
	CodeInvalid         = "invalid"
	CodeNotFound        = "not_found"
	CodeConflict        = "conflict"
	CodeInternal        = "internal"
	CodeUnavailable     = "unavailable"
)

type ctxKey int

const requestIDKey ctxKey = 0

func JSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "err", err, "path", r.URL.Path)
	}
}

func NoContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

// Fail writes the error shape the frontend expects. The message is safe to show
// a merchant: anything that would leak internals stays in the log.
func Fail(w http.ResponseWriter, r *http.Request, status int, code, message string, fields ...FieldError) {
	JSON(w, r, status, ErrorBody{
		Code:        code,
		Message:     message,
		FieldErrors: fields,
		RequestID:   RequestID(r),
	})
}

func RequestID(r *http.Request) string {
	if id, ok := r.Context().Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}

// WithRequestID tags every request so a merchant's error message and a log line
// can be tied together during support.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)
		ctx := contextWithRequestID(r.Context(), id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// DecodeJSON reads a request body, refusing unknown fields so a typo in the
// client is an error here rather than a silently ignored value.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		Fail(w, r, http.StatusBadRequest, CodeInvalid, "The request body could not be read.")
		return false
	}
	return true
}
