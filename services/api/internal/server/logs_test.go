package server

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
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
