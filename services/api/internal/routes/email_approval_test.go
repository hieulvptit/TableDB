package routes

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/tickets"
)

func TestEmailApprovalPreviewDoesNotRequireOrTouchDatabase(t *testing.T) {
	d := &app.Deps{Cfg: &config.Config{PublicURL: "https://bo.example"}, Now: time.Now, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Tickets: &tickets.Service{}}
	mux := http.NewServeMux()
	h := &H{D: d}
	h.registerEmailApproval(app.NewRouter(mux, d, "/api/v1"))
	for _, method := range []string{"GET", "HEAD"} {
		req := httptest.NewRequest(method, "https://bo.example/api/v1/email-approval", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("preview: %d %s", w.Code, w.Body.String())
		}
	}
	for _, origin := range []string{"", "https://evil.example"} {
		req := httptest.NewRequest("POST", "https://bo.example/api/v1/email-approval", strings.NewReader(`{"token":"invalid"}`))
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("cross-origin POST accepted: %d", w.Code)
		}
	}
	req := httptest.NewRequest("POST", "https://bo.example/api/v1/email-approval", strings.NewReader(`{"token":"invalid"}`))
	req.Header.Set("Origin", "https://bo.example")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("invalid token accepted: %d", w.Code)
	}
}
