// Package hrm: signed client for HRMApi GET /hrm/v1/api/managers and local leader provisioning (services/hrm.ts).
package hrm

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/config"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/httpx"
)

type Manager struct {
	Level          string
	EmployeeCode   string
	FullName       string
	Email          string
	JobTitleName   string
	DepartmentName string
}

// Signature = Base64(HmacSHA256(`${key}|${requestId}|${timestampMs}`, secret)) — mirrors HRMApi ProfileService.verifyMacSinature.
func Signature(secret, key, requestID, timestamp string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(key + "|" + requestID + "|" + timestamp))
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

type Client struct {
	Cfg config.HRM
	Out *httpx.Outbound
}

func (c *Client) Configured() bool { return c != nil && c.Cfg.BaseURL != "" && c.Cfg.Secret != "" }

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ManagersOf: GET {HRM_BASE_URL}/hrm/v1/api/managers?email=… → managers above the employee.
func (c *Client) ManagersOf(ctx context.Context, email string) ([]Manager, error) {
	if !c.Configured() {
		return nil, apperr.NewInternal("HRM is not configured")
	}
	key := strings.TrimSpace(email)
	requestID := newUUID()
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	req, err := http.NewRequest("GET", c.Cfg.BaseURL+"/hrm/v1/api/managers?email="+url.QueryEscape(key), nil)
	if err != nil {
		return nil, apperr.NewUpstream("cannot reach HRM")
	}
	req.Header.Set("X-RequestID", requestID)
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("Signature", Signature(c.Cfg.Secret, key, requestID, ts))
	req.Header.Set("Accept", "application/json")
	res, cancel, err := c.Out.Do(ctx, httpx.HopHRM, req, 0)
	if err != nil {
		return nil, apperr.NewUpstream("cannot reach HRM")
	}
	defer cancel()
	defer res.Body.Close()
	text, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, apperr.NewUpstream("cannot reach HRM")
	}
	var body struct {
		Code     string           `json:"code"`
		Managers []map[string]any `json:"managers"`
	}
	var raw map[string]any
	parsed := json.Unmarshal(text, &raw) == nil
	if parsed {
		_ = json.Unmarshal(text, &body)
	}
	if res.StatusCode == 404 && body.Code == "04" {
		return []Manager{}, nil // employee not in HRM (or not E_HIRE): no managers
	}
	_, hasArr := raw["managers"].([]any)
	if res.StatusCode < 200 || res.StatusCode > 299 || body.Code != "00" || !hasArr {
		extra := ""
		if body.Code != "" {
			extra = " code " + body.Code
		}
		return nil, apperr.NewUpstream(fmt.Sprintf("HRM error (%d%s)", res.StatusCode, extra))
	}
	out := []Manager{}
	for _, m := range body.Managers {
		e, _ := m["email"].(string)
		if !strings.Contains(e, "@") {
			continue
		}
		s := func(k string) string {
			switch v := m[k].(type) {
			case string:
				return v
			case float64:
				return strconv.FormatFloat(v, 'f', -1, 64)
			}
			return ""
		}
		out = append(out, Manager{Level: s("level"), EmployeeCode: s("employeeCode"), FullName: s("fullName"),
			Email: strings.ToLower(strings.TrimSpace(e)), JobTitleName: s("jobTitleName"), DepartmentName: s("departmentName")})
	}
	return out, nil
}

type LocalUser struct {
	ID, Name, Email string
	Active          bool
}

// EnsureLeaderUsers makes sure each HRM manager has an active local user holding the leader role (so they can sign in and approve).
func EnsureLeaderUsers(ctx context.Context, q db.Runner, ms []Manager) (map[string]LocalUser, error) {
	out := map[string]LocalUser{}
	err := q.InTx(ctx, func(t db.Runner) error {
		for _, m := range ms {
			var u LocalUser
			err := t.QueryRow(ctx, "SELECT id::text, name, email, active FROM users WHERE lower(email)=$1 LIMIT 1", m.Email).Scan(&u.ID, &u.Name, &u.Email, &u.Active)
			if err != nil {
				if !db.IsNoRows(err) {
					return err
				}
				if err := t.QueryRow(ctx, "INSERT INTO users (provider, subject, email, name) VALUES ('hrm',$1,$1,$2) RETURNING id::text, name, email, active", m.Email, m.FullName).Scan(&u.ID, &u.Name, &u.Email, &u.Active); err != nil {
					return err
				}
				if _, err := t.Exec(ctx, "INSERT INTO role_assignments (user_id, role) VALUES ($1,'user') ON CONFLICT DO NOTHING", u.ID); err != nil {
					return err
				}
				if err := audit.Write(ctx, t, audit.Entry{ActorLabel: "hrm-sync", Action: "user.provisioned", ResourceType: "user", ResourceID: u.ID, Detail: map[string]any{"provider": "hrm"}}); err != nil {
					return err
				}
			}
			if _, err := t.Exec(ctx, "INSERT INTO role_assignments (user_id, role) VALUES ($1,'leader') ON CONFLICT DO NOTHING", u.ID); err != nil {
				return err
			}
			if u.Name == "" {
				u.Name = m.FullName
			}
			out[m.Email] = u
		}
		return nil
	})
	return out, err
}
