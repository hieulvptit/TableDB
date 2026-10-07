package app_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/server"
	"vnpay/tabledb-api/internal/shared"
)

func TestAPIErrorLogsAndPublicResponses(t *testing.T) {
	for _, tc := range []struct {
		name, code, level string
		err               error
		status            int
	}{
		{"validation", "VALIDATION", "WARN", &shared.ValidationError{Issues: []shared.Issue{{Path: "email", Message: "invalid email"}}}, 400},
		{"forbidden", "FORBIDDEN", "WARN", apperr.NewForbidden("missing audit.read"), 403},
		{"upstream", "UPSTREAM", "ERROR", apperr.NewUpstream("HRM connection failed"), 502},
		{"database", "INTERNAL", "ERROR", fmt.Errorf("load ticket: %w", &pgconn.PgError{Code: "08006", Message: "database connection lost"}), 500},
		{"unknown", "INTERNAL", "ERROR", errors.New("unexpected adapter failure"), 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			log := server.NewLogger(&output, slog.LevelInfo).With("request_id", "req-error")
			w := httptest.NewRecorder()
			app.WriteError(w, log, tc.err)
			var entry map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.status || entry["status"] != float64(tc.status) || entry["code"] != tc.code || entry["level"] != tc.level || entry["request_id"] != "req-error" || entry["error"] == nil {
				t.Fatalf("missing error diagnostics: %v; status=%d", entry, w.Code)
			}
			if tc.name == "database" && (entry["sqlstate"] != "08006" || strings.Contains(w.Body.String(), "database connection lost")) {
				t.Fatal("database diagnostics missing or public error exposed internal cause")
			}
			if tc.name == "validation" && entry["validation_fields"] == nil {
				t.Fatal("missing validation field names")
			}
		})
	}
}

func TestRouterErrorLogsIncludeTraceAndRouteTemplate(t *testing.T) {
	var output bytes.Buffer
	d := &app.Deps{Cfg: &config.Config{}, Log: server.NewLogger(&output, slog.LevelInfo)}
	mux := http.NewServeMux()
	router := app.NewRouter(mux, d, "/api/v1")
	router.GET("/tickets/{id}", app.Opts{Public: true}, func(http.ResponseWriter, *http.Request) error {
		return apperr.Validation("invalid ticket")
	})
	w := httptest.NewRecorder()
	w.Header().Set("X-Request-ID", "req-route")
	r := httptest.NewRequest("GET", "/api/v1/tickets/private-id?token=private-query", nil)
	mux.ServeHTTP(w, r)
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["request_id"] != "req-route" || entry["route"] != "GET /api/v1/tickets/{id}" || entry["ip"] == nil || entry["method"] != "GET" {
		t.Fatalf("missing request context: %v", entry)
	}
	if strings.Contains(output.String(), "private-id") || strings.Contains(output.String(), "private-query") {
		t.Fatal("route diagnostics contain request values")
	}
}
