package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"

	"go.uber.org/zap"
	"go.uber.org/zap/exp/zapslog"
	"go.uber.org/zap/zapcore"

	"vnpay/tabledb-api/internal/shared"
)

// NewLogger uses Zap's unsampled JSON core behind the existing slog interface.
// Writes are synchronous to preserve rotating-file behavior without a buffer
// that could lose the last error on shutdown.
func NewLogger(w io.Writer, level slog.Level) *slog.Logger {
	cfg := zap.NewProductionEncoderConfig()
	cfg.TimeKey, cfg.MessageKey = "time", "msg"
	cfg.EncodeTime = zapcore.RFC3339NanoTimeEncoder
	cfg.EncodeLevel = zapcore.CapitalLevelEncoder
	core := zapcore.NewCore(zapcore.NewJSONEncoder(cfg), zapcore.Lock(zapcore.AddSync(w)), zapcore.Level(level/4))
	h := zapslog.NewHandler(core, zapslog.WithCaller(true), zapslog.AddStacktraceAt(slog.LevelError))
	return slog.New(redactingHandler{next: h})
}

type redactingHandler struct{ next slog.Handler }

func (h redactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h redactingHandler) Handle(ctx context.Context, r slog.Record) error {
	clean := slog.NewRecord(r.Time, r.Level, shared.RedactSecrets(r.Message), r.PC)
	r.Attrs(func(a slog.Attr) bool { clean.AddAttrs(redactAttr(a)); return true })
	return h.next.Handle(ctx, clean)
}

func (h redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clean := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		clean[i] = redactAttr(a)
	}
	return redactingHandler{next: h.next.WithAttrs(clean)}
}

func (h redactingHandler) WithGroup(name string) slog.Handler {
	return redactingHandler{next: h.next.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
	if sensitiveLogKey(a.Key) {
		return slog.String(a.Key, "[REDACTED]")
	}
	a.Value = a.Value.Resolve()
	switch a.Value.Kind() {
	case slog.KindString:
		a.Value = slog.StringValue(shared.RedactSecrets(a.Value.String()))
	case slog.KindGroup:
		attrs := a.Value.Group()
		clean := make([]slog.Attr, len(attrs))
		for i, child := range attrs {
			clean[i] = redactAttr(child)
		}
		a.Value = slog.GroupValue(clean...)
	case slog.KindAny:
		if err, ok := a.Value.Any().(error); ok {
			a.Value = slog.StringValue(shared.RedactSecrets(err.Error()))
		} else {
			// Normalize maps, slices and structs before recursively masking secret keys.
			encoded, err := json.Marshal(a.Value.Any())
			var value any
			dec := json.NewDecoder(bytes.NewReader(encoded))
			dec.UseNumber()
			if err != nil || dec.Decode(&value) != nil {
				a.Value = slog.StringValue("[UNSERIALIZABLE]")
			} else {
				a.Value = slog.AnyValue(redactLogValue(value))
			}
		}
	}
	return a
}

func redactLogValue(v any) any {
	switch value := v.(type) {
	case string:
		return shared.RedactSecrets(value)
	case map[string]any:
		for key, child := range value {
			if sensitiveLogKey(key) {
				value[key] = "[REDACTED]"
			} else {
				value[key] = redactLogValue(child)
			}
		}
	case []any:
		for i, child := range value {
			value[i] = redactLogValue(child)
		}
	}
	return v
}

func sensitiveLogKey(key string) bool {
	if shared.IsSensitiveKey(key) {
		return true
	}
	switch strings.ToLower(strings.ReplaceAll(key, "-", "_")) {
	case "csrf_token", "x_csrf_token", "session_id", "x_tabledb_session", "signing_key", "private_key", "aes_key", "data_key", "secure_web_signing_key", "secure_desktop_signing_key":
		return true
	}
	return false
}
