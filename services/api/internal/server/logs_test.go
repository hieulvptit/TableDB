package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"vnpay/tabledb-api/internal/config"
)

func TestLoggerRedactsSecretsInFileOutput(t *testing.T) {
	var b bytes.Buffer
	log := NewLogger(&b, slog.LevelInfo)
	log.Info("request", "authorization", "Bearer abcdefghijklmnop123456", "csrf_token", "xyz", "cookie", "sid=1", "password", "pw", "note", "got Bearer abcdefghijklmnop123456 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "user", "alice@vnpay.vn")
	out := b.String()
	for _, leak := range []string{"abcdefghijklmnop123456", "eyJhbGci", "sid=1", `"pw"`} {
		if strings.Contains(out, leak) {
			t.Errorf("secret %q reached the log: %s", leak, out)
		}
	}
	var m map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(b.Bytes()), &m); err != nil {
		t.Fatal(err)
	}
	if m["user"] != "alice@vnpay.vn" {
		t.Errorf("e-mail in logs is legitimate: %v", m["user"])
	}
}

func TestZapCallerStacktraceAndNestedRedaction(t *testing.T) {
	var b bytes.Buffer
	log := NewLogger(&b, slog.LevelDebug).With("request_id", "req-123", "password", "with-secret")
	log.Warn("expected rejection", "code", "VALIDATION")
	log.WithGroup("details").Error("failed Bearer message-secret-123456", "error", errors.New("upstream Bearer error-secret-123456"),
		"nested", map[string]any{"token": "nested-secret", "user": "alice@vnpay.vn", "rows": []any{map[string]any{"csrf_token": "csrf-secret"}}},
		slog.Group("credentials", slog.String("private_key", "key-secret")))
	for _, secret := range []string{"with-secret", "message-secret-123456", "error-secret-123456", "nested-secret", "csrf-secret", "key-secret"} {
		if strings.Contains(b.String(), secret) {
			t.Fatalf("secret leaked: %s", secret)
		}
	}
	lines := strings.Split(strings.TrimSpace(b.String()), "\n")
	for i, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["request_id"] != "req-123" || entry["time"] == nil || !strings.Contains(entry["caller"].(string), "logs_test.go:") {
			t.Fatalf("missing trace fields: %v", entry)
		}
		if i == 0 && entry["stacktrace"] != nil {
			t.Fatal("expected rejection has an unnecessary stacktrace")
		}
		if i == 1 && !strings.Contains(entry["stacktrace"].(string), "TestZapCallerStacktraceAndNestedRedaction") {
			t.Fatal("server error lost stacktrace")
		}
	}
	if !strings.Contains(b.String(), "alice@vnpay.vn") {
		t.Fatal("operational identity was masked")
	}
}

func TestZapLevelFilteringAndConcurrentUnsampledWrites(t *testing.T) {
	var b bytes.Buffer
	log := NewLogger(&b, slog.LevelWarn)
	log.Debug("debug hidden")
	log.Info("info hidden")
	var workers sync.WaitGroup
	for range 4 {
		workers.Go(func() {
			for range 50 {
				log.Warn("repeated failure", "code", "SECURE_RECORD")
			}
		})
	}
	workers.Wait()
	lines := strings.Split(strings.TrimSpace(b.String()), "\n")
	if len(lines) != 200 {
		t.Fatalf("lost failures or incorrect level filtering: %d lines", len(lines))
	}
	for _, line := range lines {
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil || entry["level"] != "WARN" {
			t.Fatalf("corrupt log line: %s", line)
		}
	}
}

func TestOpenLogsUsesConfiguredDirAndOptions(t *testing.T) {
	base := t.TempDir()
	cfg, err := config.Load(map[string]string{"APP_BASE_DIR": base, "LOG_MAX_SIZE_MB": "3", "AUDIT_FILE_ENABLED": "0"})
	if err != nil {
		t.Fatal(err)
	}
	logs, err := OpenLogs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer logs.Close()
	if logs.App == nil || logs.Audit != nil || logs.App.MaxSize != 3 {
		t.Fatalf("logs: %+v", logs)
	}
	AppLogger(cfg, logs).Info("hello", "k", "v")
	b, err := os.ReadFile(filepath.Join(base, "logs", "app.log"))
	if err != nil || !strings.Contains(string(b), `"msg":"hello"`) {
		t.Fatalf("app.log under <base>/logs: %v %q", err, b)
	}
}
