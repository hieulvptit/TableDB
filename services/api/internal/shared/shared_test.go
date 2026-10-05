package shared

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

const vectorsPath = "../../../../packages/shared/testdata/sql-classify.json" // shared with the TS and Java classifiers

func TestSqlClassifierVectors(t *testing.T) {
	b, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("shared test vectors not found (%s): %v", vectorsPath, err)
	}
	var v struct {
		Cases []struct {
			SQL   string `json:"sql"`
			Kind  string `json:"kind"`
			Multi bool   `json:"multi"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 40 {
		t.Fatalf("suspiciously few vectors: %d", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.SQL, func(t *testing.T) {
			r := ClassifySQL(c.SQL)
			if r.Multi != c.Multi {
				t.Fatalf("multi = %v, want %v", r.Multi, c.Multi)
			}
			// multi statements are always non-read for executors; vectors only pin the `kind` of single statements
			want := SqlKind(c.Kind)
			if c.Multi {
				want = SqlOther
			}
			if r.Kind != want {
				t.Fatalf("kind = %s, want %s", r.Kind, want)
			}
		})
	}
}

func TestClassifyKindOfAll(t *testing.T) {
	if k := ClassifyKindOfAll("SELECT 1; DROP TABLE t"); k != SqlDDL {
		t.Fatal(k)
	}
	if k := ClassifyKindOfAll("SELECT 1; SELECT 2"); k != SqlRead {
		t.Fatal(k)
	}
	if k := ClassifyKindOfAll(""); k != SqlOther {
		t.Fatal(k)
	}
}

func TestRedaction(t *testing.T) {
	if got := MaskSQL("select * from t where a='x' and b=123 and c2=5"); got != "select * from t where a=? and b=? and c2=?" {
		t.Fatal(got)
	}
	if got := MaskSQL("select 'it''s', 1.5e3, t1.x from t1 where n=-7"); got != "select ?, ?, t1.x from t1 where n=-?" {
		t.Fatal(got)
	}
	o := RedactObject(map[string]any{"password": "p", "nested": map[string]any{"token": "t", "note": "mail a.b@vnpay.vn card 4111 1111 1111 1111"}}).(map[string]any)
	if o["password"] != "[REDACTED]" || o["nested"].(map[string]any)["token"] != "[REDACTED]" {
		t.Fatalf("%v", o)
	}
	note := o["nested"].(map[string]any)["note"].(string)
	if strings.Contains(note, "vnpay.vn") || strings.Contains(note, "4111") {
		t.Fatal(note)
	}
	if !strings.Contains(RedactText("Authorization: Bearer abcdefghijklmnop"), "[REDACTED]") {
		t.Fatal("bearer")
	}
	// phones: the hand-written matcher must behave like the look-around regex
	cases := map[string]string{
		"call 0912345678 now":  "call [REDACTED:phone] now",
		"call +84 912 345 678": "call [REDACTED:phone]",
		"id20912345678y":       "id20912345678y",   // preceded by a digit: not a phone
		"x 091234567890 y":     "x 091234567890 y", // followed by a digit
		"0912.345.678":         "[REDACTED:phone]",
		"short 091234":         "short 091234",
	}
	for in, want := range cases {
		if got := RedactText(in); got != want {
			t.Errorf("RedactText(%q) = %q, want %q", in, got, want)
		}
	}
	deep := map[string]any{}
	cur := deep
	for i := 0; i < 12; i++ {
		n := map[string]any{}
		cur["a"] = n
		cur = n
	}
	if !strings.Contains(string(mustJSON(RedactObject(deep))), "[DEPTH]") {
		t.Fatal("depth cap")
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func p(id string, roles []Role, grants ...Permission) Principal {
	return Principal{ID: id, Roles: roles, Grants: grants, Active: true}
}

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func tk(mod func(*TicketRef)) TicketRef {
	t := TicketRef{ID: "t", RequesterID: "alice", ApproverID: "lead", Status: StatusPendingApproval, MaxDownloads: 3}
	if mod != nil {
		mod(&t)
	}
	return t
}

func TestRBAC(t *testing.T) {
	user := []Role{RoleUser}
	leader := []Role{RoleLeader}
	t.Run("only designated leader approves", func(t *testing.T) {
		if !CanApprove(p("lead", leader), tk(nil), nil, now).Allow {
			t.Fatal("designated leader")
		}
		if CanApprove(p("other", leader), tk(nil), nil, now).Allow {
			t.Fatal("other leader")
		}
		if CanApprove(p("lead", user), tk(nil), nil, now).Allow {
			t.Fatal("plain user")
		}
	})
	t.Run("requester cannot approve even if leader and approver", func(t *testing.T) {
		if CanApprove(p("alice", leader), tk(func(t *TicketRef) { t.ApproverID = "alice" }), nil, now).Allow {
			t.Fatal("self approve")
		}
	})
	t.Run("delegation must be active", func(t *testing.T) {
		d := Delegation{FromUserID: "lead", ToUserID: "dep", ValidFrom: time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC), ValidTo: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)}
		if !CanApprove(p("dep", leader), tk(nil), []Delegation{d}, now).Allow {
			t.Fatal("active delegate")
		}
		rev := d
		rev.Revoked = true
		if CanApprove(p("dep", leader), tk(nil), []Delegation{rev}, now).Allow {
			t.Fatal("revoked")
		}
		old := d
		old.ValidTo = time.Date(2025, 12, 31, 12, 0, 0, 0, time.UTC)
		if CanApprove(p("dep", leader), tk(nil), []Delegation{old}, now).Allow {
			t.Fatal("expired")
		}
	})
	t.Run("no decision on non-pending or expired ticket", func(t *testing.T) {
		if CanApprove(p("lead", leader), tk(func(t *TicketRef) { t.Status = StatusApproved }), nil, now).Allow {
			t.Fatal("approved")
		}
		past := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
		if CanApprove(p("lead", leader), tk(func(t *TicketRef) { t.ExpiresAt = &past }), nil, now).Allow {
			t.Fatal("expired")
		}
	})
	t.Run("download gate re-checks status, expiry, limit, identity, active flag", func(t *testing.T) {
		ok := tk(func(t *TicketRef) { t.Status = StatusApproved })
		past := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
		checks := []struct {
			name string
			p    Principal
			t    TicketRef
			want bool
		}{
			{"requester", p("alice", user), ok, true},
			{"stranger", p("bob", user), ok, false},
			{"recipient", p("bob", user), tk(func(t *TicketRef) { t.Status = StatusApproved; t.RecipientIDs = []string{"bob"} }), true},
			{"revoked", p("alice", user), tk(func(t *TicketRef) { t.Status = StatusRevoked }), false},
			{"pending", p("alice", user), tk(nil), false},
			{"limit", p("alice", user), tk(func(t *TicketRef) { t.Status = StatusApproved; t.DownloadCount = 3 }), false},
			{"expired", p("alice", user), tk(func(t *TicketRef) { t.Status = StatusDownloaded; t.ExpiresAt = &past }), false},
			{"inactive", Principal{ID: "alice", Roles: user, Active: false}, ok, false},
		}
		for _, c := range checks {
			if got := CanDownload(c.p, c.t, now, "").Allow; got != c.want {
				t.Errorf("%s: %v want %v", c.name, got, c.want)
			}
		}
	})
	t.Run("download only on the destination side of the transfer direction", func(t *testing.T) {
		toOffice := tk(func(t *TicketRef) { t.Status = StatusApproved; t.Direction = JumpToOffice })
		toJump := tk(func(t *TicketRef) { t.Status = StatusApproved; t.Direction = OfficeToJump })
		a := p("alice", user)
		if !CanDownload(a, toOffice, now, ClientWeb).Allow || CanDownload(a, toOffice, now, ClientDesktop).Allow ||
			!CanDownload(a, toJump, now, ClientDesktop).Allow || CanDownload(a, toJump, now, ClientWeb).Allow {
			t.Fatal("direction gate")
		}
		if DirectionForUploader(ClientWeb) != OfficeToJump || DirectionForUploader(ClientDesktop) != JumpToOffice {
			t.Fatal("direction for uploader")
		}
	})
	t.Run("view / revoke", func(t *testing.T) {
		if CanView(p("rand", user), tk(nil), nil, now).Allow || !CanView(p("lead", user), tk(nil), nil, now).Allow {
			t.Fatal("view")
		}
		if !CanRevoke(p("alice", user), tk(nil)).Allow || CanRevoke(p("rand", user), tk(nil)).Allow ||
			CanRevoke(p("alice", user), tk(func(t *TicketRef) { t.Status = StatusRejected })).Allow {
			t.Fatal("revoke")
		}
		if !CanRevoke(p("root", []Role{RoleAdmin}), tk(nil)).Allow {
			t.Fatal("admin revoke")
		}
	})
	t.Run("permissions: roles + grants, service has none", func(t *testing.T) {
		if HasPermission(&Principal{ID: "s", Roles: []Role{RoleService}, Active: true}, "db:connect") {
			t.Fatal("service")
		}
		if !HasPermission(&Principal{ID: "u", Roles: user, Grants: []Permission{"db:write"}, Active: true}, "db:write") {
			t.Fatal("grant")
		}
		if HasPermission(nil, "db:connect") {
			t.Fatal("nil")
		}
	})
	t.Run("state machine", func(t *testing.T) {
		if !CanTransition(StatusPendingApproval, StatusApproved) || CanTransition(StatusRejected, StatusApproved) || CanTransition(StatusUploading, StatusApproved) {
			t.Fatal("transitions")
		}
		if !CanTransition(StatusDownloaded, StatusDownloaded) {
			t.Fatal("DOWNLOADED self transition")
		}
	})
}

func TestUploadInitValidation(t *testing.T) {
	good := `{"fileName":"a.zip","size":10,"sha256":"` + strings.Repeat("a", 64) + `","purpose":"hello","approverId":"11111111-1111-4111-8111-111111111111","direction":"OFFICE_TO_JUMP"}`
	u, err := ParseUploadInit([]byte(good))
	if err != nil || u.FileName != "a.zip" || u.Size != 10 || len(u.RecipientIDs) != 0 {
		t.Fatalf("%+v %v", u, err)
	}
	bad := map[string]string{
		"empty":         ``,
		"not object":    `[]`,
		"short purpose": strings.Replace(good, `"hello"`, `"hey"`, 1),
		"bad sha":       strings.Replace(good, strings.Repeat("a", 64), "xyz", 1),
		"bad uuid":      strings.Replace(good, "11111111-1111-4111-8111-111111111111", "nope", 1),
		"zero size":     strings.Replace(good, `"size":10`, `"size":0`, 1),
		"float size":    strings.Replace(good, `"size":10`, `"size":1.5`, 1),
		"string size":   strings.Replace(good, `"size":10`, `"size":"10"`, 1),
		"long name":     strings.Replace(good, "a.zip", strings.Repeat("a", 256), 1),
		"21 recipients": strings.Replace(good, `"direction"`, `"recipientIds":[`+strings.TrimSuffix(strings.Repeat(`"11111111-1111-4111-8111-111111111111",`, 21), ",")+`],"direction"`, 1),
	}
	for name, body := range bad {
		if _, err := ParseUploadInit([]byte(body)); err == nil {
			t.Errorf("%s: accepted", name)
		} else if _, ok := err.(*ValidationError); !ok {
			t.Errorf("%s: wrong error type %T", name, err)
		}
	}
}

func TestDecisionValidation(t *testing.T) {
	if d, err := ParseDecisionBody([]byte(`{"decision":"approve"}`)); err != nil || d.Reason != nil {
		t.Fatal(err)
	}
	for _, b := range []string{`{"decision":"reject"}`, `{"decision":"reject","reason":" a "}`, `{"decision":"maybe"}`, `{}`, `{"decision":"approve","reason":` + `"` + strings.Repeat("x", 1001) + `"}`} {
		if _, err := ParseDecisionBody([]byte(b)); err == nil {
			t.Errorf("%s accepted", b)
		}
	}
	if _, err := ParseDecisionBody([]byte(`{"decision":"reject","reason":"vì sao"}`)); err != nil {
		t.Fatal(err)
	}
}
