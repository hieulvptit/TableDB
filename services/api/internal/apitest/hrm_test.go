package apitest

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/hrm"
)

const hrmSecret = "test-secret"

type hrmMock struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seen []string
}

func (m *hrmMock) Seen() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.seen...)
}

// startHRM mirrors HRMApi ProfileService.getManagers/verifyMacSinature: Base64(HmacSHA256(email|X-RequestID|X-Timestamp)), 10 min window.
func startHRM(t *testing.T) *hrmMock {
	m := &hrmMock{}
	managers := []map[string]any{
		{"level": "TEAM_LEADER", "employeeCode": "E1", "fullName": "Trưởng Nhóm", "email": "Lead1@vnpay.vn", "jobTitleName": "Trưởng nhóm", "departmentName": "D"},
		{"level": "HEAD_OF_DEPARTMENT", "employeeCode": "E2", "fullName": "Trưởng Phòng", "email": "head@vnpay.vn"},
		{"level": "TEAM_LEADER", "employeeCode": "E3", "fullName": "Không email", "email": nil},
	}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.seen = append(m.seen, r.URL.RequestURI())
		m.mu.Unlock()
		send := func(st int, b any) { w.WriteHeader(st); _ = json.NewEncoder(w).Encode(b) }
		if r.URL.Path != "/dataservice/hrm/v1/api/managers" {
			send(404, map[string]any{})
			return
		}
		rid, ts, sig := r.Header.Get("X-RequestID"), r.Header.Get("X-Timestamp"), r.Header.Get("Signature")
		email := r.URL.Query().Get("email")
		if rid == "" || ts == "" || sig == "" {
			send(400, map[string]any{"code": "02"})
			return
		}
		tms, _ := strconv.ParseInt(ts, 10, 64)
		if d := time.Now().UnixMilli() - tms; d > 600_000 || d < -600_000 {
			send(401, map[string]any{"code": "05"})
			return
		}
		mac := hmac.New(sha256.New, []byte(hrmSecret))
		mac.Write([]byte(email + "|" + rid + "|" + ts))
		if base64.StdEncoding.EncodeToString(mac.Sum(nil)) != sig {
			send(401, map[string]any{"code": "06"})
			return
		}
		if strings.EqualFold(email, "nobody@vnpay.vn") {
			send(404, map[string]any{"code": "04"})
			return
		}
		send(200, map[string]any{"code": "00", "email": email, "managers": managers})
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func TestHRMSignature(t *testing.T) {
	mac := hmac.New(sha256.New, []byte("s"))
	mac.Write([]byte("a@b.c|r|1"))
	if got, want := hrm.Signature("s", "a@b.c", "r", "1"), base64.StdEncoding.EncodeToString(mac.Sum(nil)); got != want {
		t.Fatalf("signature %s want %s", got, want)
	}
}

func hrmHarness(t *testing.T) (*Harness, *hrmMock) {
	m := startHRM(t)
	return harness(t, map[string]string{"HRM_BASE_URL": m.srv.URL + "/dataservice", "HRM_SIGNATURE_SECRET": hrmSecret}), m
}

func TestHRMApprovers(t *testing.T) {
	t.Run("options lists the requester's managers (signed call, by email); managers without email are dropped", func(t *testing.T) {
		h, m := hrmHarness(t)
		alice := h.User("alice@vnpay.vn")
		r := alice.Get("/transfers/options")
		status(t, r, 200, "options")
		var emails []string
		for _, l := range r.Get("leaders").([]any) {
			emails = append(emails, l.(map[string]any)["email"].(string))
		}
		sort.Strings(emails)
		eq(t, strings.Join(emails, ","), "head@vnpay.vn,lead1@vnpay.vn", "leaders")
		if len(m.Seen()) == 0 || !strings.Contains(m.Seen()[0], "email=alice%40vnpay.vn") {
			t.Fatalf("hrm calls: %v", m.Seen())
		}
		// titles pass through when HRM has them
		for _, l := range r.Get("leaders").([]any) {
			lm := l.(map[string]any)
			if lm["email"] == "lead1@vnpay.vn" && lm["title"] != "Trưởng nhóm" {
				t.Fatalf("title %v", lm["title"])
			}
		}
	})
	t.Run("a listed manager can be chosen as approver and then approve; a non-manager is rejected", func(t *testing.T) {
		h, _ := hrmHarness(t)
		alice := h.User("alice@vnpay.vn")
		var leadID string
		for _, l := range alice.Get("/transfers/options").Get("leaders").([]any) {
			if lm := l.(map[string]any); lm["email"] == "lead1@vnpay.vn" {
				leadID = lm["id"].(string)
			}
		}
		stranger := h.User("stranger@vnpay.vn")
		bad := alice.Post("/transfers", map[string]any{"fileName": "a.csv", "size": 10, "sha256": strings.Repeat("a", 64), "purpose": "abc12", "approverId": stranger.ID, "recipientIds": []string{}})
		status(t, bad, 400, "non-manager approver")
		// a stranger who holds the leader role locally but is not in HRM is still refused
		h.AddLeader(stranger.ID)
		bad = alice.Post("/transfers", map[string]any{"fileName": "a.csv", "size": 10, "sha256": strings.Repeat("a", 64), "purpose": "abc12", "approverId": stranger.ID, "recipientIds": []string{}})
		status(t, bad, 400, "local leader not in HRM")
		up := h.UploadFile(alice, Upload{ApproverID: leadID, Content: h.Randbytes(10)})
		h.Work()
		boss := h.User("lead1@vnpay.vn")
		status(t, boss.Post("/transfers/"+up.TicketID+"/decision", map[string]any{"decision": "approve"}), 200, "manager approves")
	})
	t.Run("HRM failure surfaces as an upstream error, not an empty list", func(t *testing.T) {
		h, m := hrmHarness(t)
		m.srv.Close()
		alice := h.User("alice@vnpay.vn")
		r := alice.Get("/transfers/options")
		atLeast(t, r, 500, "hrm down")
		eq(t, r.Code(), "UPSTREAM", "code")
	})
	t.Run("employee unknown to HRM has no approvers (404 code 04)", func(t *testing.T) {
		h, _ := hrmHarness(t)
		r := h.User("nobody@vnpay.vn").Get("/transfers/options")
		status(t, r, 200, "options")
		eq(t, len(r.Get("leaders").([]any)), 0, "leaders")
	})
	t.Run("wrong secret is rejected by HRM and reported upstream", func(t *testing.T) {
		m := startHRM(t)
		h := harness(t, map[string]string{"HRM_BASE_URL": m.srv.URL + "/dataservice", "HRM_SIGNATURE_SECRET": "wrong"})
		r := h.User("alice@vnpay.vn").Get("/transfers/options")
		status(t, r, 502, "bad signature")
	})
}

func TestProdConfigHRM(t *testing.T) {
	base := prodBase()
	delete(base, "HRM_BASE_URL")
	delete(base, "HRM_SIGNATURE_SECRET")
	if _, err := config.Load(base); err == nil || !strings.Contains(err.Error(), "HRM_BASE_URL") {
		t.Fatalf("missing HRM: %v", err)
	}
	base["HRM_BASE_URL"], base["HRM_SIGNATURE_SECRET"] = "http://h/dataservice", "s"
	if _, err := config.Load(base); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("http HRM: %v", err)
	}
	base["HRM_BASE_URL"] = "https://h/dataservice"
	c, err := config.Load(base)
	if err != nil || c.HRM.BaseURL != "https://h/dataservice" {
		t.Fatalf("valid: %v", err)
	}
}
