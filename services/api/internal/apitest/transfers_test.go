package apitest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vnpay/tabledb-api/internal/scan"
)

type tctx struct {
	*Harness
	S *Seed
}

func newT(t *testing.T) *tctx {
	h := harness(t)
	return &tctx{h, h.SeedTransfer()}
}

func (x *tctx) content() []byte { return x.Randbytes(2500) } // 3 parts of 1024

func (x *tctx) status(c *Client, id string) map[string]any {
	x.T.Helper()
	return c.Get("/transfers/" + id).Get("ticket").(map[string]any)
}

type pendingT struct {
	Uploaded
	Buf []byte
}

func (x *tctx) toPending(o ...Upload) pendingT {
	x.T.Helper()
	u := Upload{ApproverID: x.S.Lead.ID}
	if len(o) > 0 {
		u = o[0]
		if u.ApproverID == "" {
			u.ApproverID = x.S.Lead.ID
		}
	}
	if u.Content == nil {
		u.Content = x.content()
	}
	up := x.UploadFile(x.S.Alice, u)
	x.Work()
	return pendingT{up, u.Content}
}

func pathOf(raw string) string {
	u, _ := url.Parse(raw)
	return strings.TrimPrefix(u.Path, "/api/v1") + "?" + u.RawQuery
}

func (x *tctx) downloadOnce(c *Client, id string) *Resp {
	x.T.Helper()
	t := c.Post("/transfers/"+id+"/download-token", nil)
	if t.Status != 200 {
		return t
	}
	return c.Get(pathOf(t.Str("url")))
}

func (x *tctx) approve(c *Client, id string) *Resp {
	return c.Post("/transfers/"+id+"/decision", map[string]any{"decision": "approve"})
}

func eq[T comparable](t *testing.T, got, want T, what string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

func status(t *testing.T, r *Resp, want int, what string) {
	t.Helper()
	if r.Status != want {
		t.Fatalf("%s: HTTP %d (want %d): %s", what, r.Status, want, r.Body)
	}
}

func atLeast(t *testing.T, r *Resp, min int, what string) {
	t.Helper()
	if r.Status < min {
		t.Fatalf("%s: HTTP %d (want >= %d): %s", what, r.Status, min, r.Body)
	}
}

func TestHappyPath(t *testing.T) {
	t.Run("upload → scan → approval email → leader approves → sender downloads identical bytes", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		t1 := x.status(x.S.Alice, p.TicketID)
		eq(t, t1["status"].(string), "PENDING_APPROVAL", "status")
		eq(t, t1["notifyState"].(string), "SENT", "notifyState")
		// The approver gets metadata, BO details and a scoped single-use approval link.
		mails := x.Mail.To("lead@vnpay.vn")
		eq(t, len(mails), 1, "approver mails")
		if !strings.Contains(mails[0].Subject, p.Code) || !strings.Contains(mails[0].Text, sha(p.Buf)) ||
			!strings.Contains(mails[0].Text, x.Cfg.PublicURL+"/transfers/"+p.TicketID) {
			t.Fatalf("mail content: %+v", mails[0])
		}
		if !strings.Contains(mails[0].HTML, "/api/v1/email-approval#") {
			t.Fatal("approval mail is missing the single-use approval link")
		}
		status(t, x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil), 403, "download before approval")

		d := x.approve(x.S.Lead, p.TicketID)
		status(t, d, 200, "approve")
		x.Work()
		last := x.Mail.To("alice@vnpay.vn")
		if !strings.Contains(last[len(last)-1].Subject, "Đã duyệt") {
			t.Fatalf("decision mail subject: %s", last[len(last)-1].Subject)
		}

		dl := x.downloadOnce(x.S.Alice, p.TicketID)
		status(t, dl, 200, "download")
		if string(dl.Body) != string(p.Buf) {
			t.Fatal("downloaded bytes differ")
		}
		eq(t, dl.Header.Get("X-Content-SHA256"), sha(p.Buf), "x-content-sha256")
		if !strings.Contains(dl.Header.Get("Content-Disposition"), "attachment") {
			t.Fatal("content-disposition")
		}
		x.Work()
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "DOWNLOADED", "status after download")
		eq(t, Scalar[int](x.Harness, "SELECT count(*)::int FROM downloads"), 1, "downloads rows")
		eq(t, Scalar[string](x.Harness, "SELECT sha256 FROM downloads"), sha(p.Buf), "downloads.sha256")
		eq(t, x.S.Admin.Get("/audit/verify").Bool("ok"), true, "audit verify")
		got := map[string]bool{}
		for _, e := range x.S.Admin.Get("/audit?limit=200").Get("entries").([]any) {
			got[e.(map[string]any)["action"].(string)] = true
		}
		for _, a := range []string{"transfer.create", "transfer.approve", "transfer.download", "notify.approval_sent"} {
			if !got[a] {
				t.Fatalf("audit action %s missing: %v", a, got)
			}
		}
	})

	t.Run("files are encrypted at rest", func(t *testing.T) {
		x := newT(t)
		marker := []byte(strings.Repeat("TOP-SECRET-MARKER-", 60))
		p := x.toPending(Upload{Content: marker})
		dir := filepath.Join(x.Cfg.StorageDir, p.TicketID)
		ents, err := os.ReadDir(dir)
		if err != nil || len(ents) == 0 {
			t.Fatalf("no stored parts: %v", err)
		}
		for _, e := range ents {
			b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			if strings.Contains(string(b), "TOP-SECRET-MARKER") {
				t.Fatal("plaintext found on disk")
			}
		}
	})

	t.Run("part ciphertext is bound to ticket and index (AAD): swapping parts breaks decryption", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		dir := filepath.Join(x.Cfg.StorageDir, p.TicketID)
		a, _ := os.ReadFile(filepath.Join(dir, "1"))
		b, _ := os.ReadFile(filepath.Join(dir, "2"))
		_ = os.WriteFile(filepath.Join(dir, "1"), b, 0o600)
		_ = os.WriteFile(filepath.Join(dir, "2"), a, 0o600)
		x.Scanner.Set(scan.Result{Status: scan.Clean})
		res, err := x.Deps.Tickets.Rescan(context.Background(), p.TicketID)
		if err != nil || res != string(scan.Unavailable) {
			t.Fatalf("swapped parts must fail authentication (scanner sees a read error): %q %v", res, err)
		}
	})
}

func TestApprovalAuthority(t *testing.T) {
	t.Run("requester cannot approve; non-designated leader cannot; unrelated users cannot even see it", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		status(t, x.approve(x.S.Alice, p.TicketID), 403, "requester approve")
		status(t, x.approve(x.S.Lead2, p.TicketID), 404, "other leader approve")
		status(t, x.S.Bob.Get("/transfers/"+p.TicketID), 404, "stranger view")
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "PENDING_APPROVAL", "status")
	})
	t.Run("a leader cannot pick themselves nor approve their own upload; DB constraint backs it", func(t *testing.T) {
		x := newT(t)
		own := x.S.Lead.Post("/transfers", map[string]any{"fileName": "a.zip", "size": 10, "sha256": strings.Repeat("a", 64), "purpose": "self approve attempt", "approverId": x.S.Lead.ID})
		status(t, own, 400, "self approver")
		p := x.UploadFile(x.S.Lead, Upload{ApproverID: x.S.Lead2.ID, Content: x.content()})
		x.Work()
		status(t, x.approve(x.S.Lead, p.TicketID), 403, "approve own upload")
		if _, err := x.DB.Exec(context.Background(), "UPDATE tickets SET approver_id = requester_id WHERE id=$1", p.TicketID); err == nil {
			t.Fatal("approver_not_requester constraint missing")
		}
	})
	t.Run("approver must be a configured leader", func(t *testing.T) {
		x := newT(t)
		r := x.S.Alice.Post("/transfers", map[string]any{"fileName": "a.zip", "size": 10, "sha256": strings.Repeat("a", 64), "purpose": "not a leader", "approverId": x.S.Bob.ID})
		status(t, r, 400, "non-leader approver")
	})
	t.Run("reject needs a reason and blocks download; decisions are final and immutable", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		status(t, x.S.Lead.Post("/transfers/"+p.TicketID+"/decision", map[string]any{"decision": "reject"}), 400, "reject w/o reason")
		status(t, x.S.Lead.Post("/transfers/"+p.TicketID+"/decision", map[string]any{"decision": "reject", "reason": "không hợp lệ"}), 200, "reject")
		atLeast(t, x.approve(x.S.Lead, p.TicketID), 400, "approve after reject")
		status(t, x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil), 403, "download rejected")
		if _, err := x.DB.Exec(context.Background(), "UPDATE approvals SET decision='approve'"); err == nil || !strings.Contains(err.Error(), "immutable") {
			t.Fatalf("approvals must be immutable: %v", err)
		}
		x.Work()
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "REJECTED", "status")
		eq(t, x.Deps.Store.Exists(p.TicketID+"/1"), false, "content purged")
	})
	t.Run("active delegate can decide; revoked delegation cannot", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		from := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		to := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
		dg := x.S.Lead.Post("/delegations", map[string]any{"toUserId": x.S.Lead2.ID, "validFrom": from, "validTo": to})
		status(t, dg, 201, "delegate")
		x.S.Lead.Del("/delegations/" + dg.Str("id"))
		status(t, x.approve(x.S.Lead2, p.TicketID), 404, "revoked delegate")
		status(t, x.S.Lead.Post("/delegations", map[string]any{"toUserId": x.S.Lead2.ID, "validFrom": from, "validTo": to}), 201, "delegate again")
		found := false
		for _, tk := range x.S.Lead2.Get("/transfers?view=approvals").Get("tickets").([]any) {
			if tk.(map[string]any)["id"] == p.TicketID {
				found = true
			}
		}
		if !found {
			t.Fatal("delegate does not see the ticket in approvals")
		}
		d := x.approve(x.S.Lead2, p.TicketID)
		status(t, d, 200, "delegate approves")
		eq(t, Scalar[string](x.Harness, "SELECT decided_by::text FROM approvals"), x.S.Lead2.ID, "decided_by")
		eq(t, Scalar[string](x.Harness, "SELECT on_behalf_of::text FROM approvals"), x.S.Lead.ID, "on_behalf_of")
	})
	t.Run("expired delegation cannot decide", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		x.S.Lead.Post("/delegations", map[string]any{"toUserId": x.S.Lead2.ID, "validFrom": time.Now().Add(-2 * time.Hour).Format(time.RFC3339), "validTo": time.Now().Add(time.Hour).Format(time.RFC3339)})
		x.Exec("UPDATE delegations SET valid_from = now() - interval '3 hours', valid_to = now() - interval '1 hour'")
		status(t, x.approve(x.S.Lead2, p.TicketID), 404, "expired delegate")
	})
	t.Run("admin changes approver → old leader loses access", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		status(t, x.S.Admin.Post("/transfers/"+p.TicketID+"/change-approver", map[string]any{"approverId": x.S.Lead2.ID}), 200, "change approver")
		status(t, x.approve(x.S.Lead, p.TicketID), 404, "old leader")
		status(t, x.approve(x.S.Lead2, p.TicketID), 200, "new leader")
	})
}

func TestDownloadGate(t *testing.T) {
	approved := func(x *tctx, rec ...string) pendingT {
		var o Upload
		o.RecipientIDs = rec
		p := x.toPending(o)
		x.ExpectOK(x.approve(x.S.Lead, p.TicketID))
		return p
	}
	t.Run("requires step-up when the login is older than policy", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		x.Exec("UPDATE sessions SET auth_time = now() - interval '1 hour'")
		r := x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil)
		status(t, r, 401, "stale login")
		eq(t, r.Code(), "STEPUP_REQUIRED", "code")
		eq(t, r.Header.Get("X-Stepup"), "required", "x-stepup")
	})
	t.Run("token is single-use and bound to user and ticket", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		tok := x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil)
		path := pathOf(tok.Str("url"))
		status(t, x.S.Bob.Get(path), 403, "other user redeems")
		status(t, x.S.Alice.Get(path), 200, "owner redeems")
		status(t, x.S.Alice.Get(path), 403, "replay")
		status(t, x.S.Bob.Post("/transfers/"+p.TicketID+"/download-token", nil), 404, "stranger token")
	})
	t.Run("designated recipients can download, others cannot", func(t *testing.T) {
		x := newT(t)
		p := approved(x, x.S.Bob.ID)
		r := x.downloadOnce(x.S.Bob, p.TicketID)
		status(t, r, 200, "recipient")
		if string(r.Body) != string(p.Buf) {
			t.Fatal("bytes differ")
		}
		status(t, x.downloadOnce(x.S.Lead2, p.TicketID), 404, "outsider")
	})
	t.Run("enforces max downloads", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		for i := 0; i < 3; i++ {
			status(t, x.downloadOnce(x.S.Alice, p.TicketID), 200, fmt.Sprintf("download %d", i+1))
		}
		status(t, x.downloadOnce(x.S.Alice, p.TicketID), 403, "4th download")
	})
	t.Run("revocation kills outstanding tokens and future downloads; content is purged", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		tok := x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil)
		status(t, x.S.Alice.Post("/transfers/"+p.TicketID+"/revoke", map[string]any{"reason": "gửi nhầm"}), 200, "revoke")
		status(t, x.S.Alice.Get(pathOf(tok.Str("url"))), 403, "token after revoke")
		x.Work()
		eq(t, x.Deps.Store.Exists(p.TicketID+"/1"), false, "content purged")
	})
	t.Run("expiry is checked at download time and by the sweeper", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		x.Exec("UPDATE tickets SET expires_at = now() - interval '1 minute'")
		status(t, x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil), 403, "expired")
		n, err := x.Deps.Tickets.SweepExpired(context.Background())
		if err != nil || n != 1 {
			t.Fatalf("sweep: %d %v", n, err)
		}
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "EXPIRED", "status")
	})
	t.Run("a deactivated user loses access immediately", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		off := false
		x.SetUser(x.S.Alice.ID, UserSet{Roles: []string{"user"}, Active: &off})
		status(t, x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil), 401, "deactivated")
	})
	t.Run("permission is re-evaluated at download time even with a valid token", func(t *testing.T) {
		x := newT(t)
		p := approved(x)
		tok := x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil)
		on := true
		x.SetUser(x.S.Alice.ID, UserSet{Roles: []string{"service"}, Active: &on})
		status(t, x.S.Alice.Get(pathOf(tok.Str("url"))), 403, "role downgraded")
	})
}

func TestUploadRobustness(t *testing.T) {
	t.Run("resumes: reports received parts; complete is idempotent; one approval email", func(t *testing.T) {
		x := newT(t)
		buf := x.content()
		created := x.S.Alice.Post("/transfers", map[string]any{"fileName": "r.zip", "size": len(buf), "sha256": sha(buf), "purpose": "resume test purpose", "approverId": x.S.Lead.ID})
		id := created.Str("ticket.id")
		pb := int(created.Num("partBytes"))
		part := func(n int) []byte {
			end := n * pb
			if end > len(buf) {
				end = len(buf)
			}
			return buf[(n-1)*pb : end]
		}
		put := func(n int, b []byte, shaHex string) *Resp {
			return x.S.Alice.Req("PUT", fmt.Sprintf("/transfers/%s/parts/%d", id, n), Opt{Raw: b, Headers: map[string]string{"X-Part-SHA256": shaHex}})
		}
		x.ExpectOK(put(1, part(1), sha(part(1))))
		x.ExpectOK(put(3, part(3), sha(part(3))))
		rp := x.S.Alice.Get("/transfers/" + id).Get("receivedParts").([]any)
		if len(rp) != 2 || rp[0].(float64) != 1 || rp[1].(float64) != 3 {
			t.Fatalf("receivedParts %v", rp)
		}
		idem := map[string]string{"Idempotency-Key": "key-12345678"}
		early := x.S.Alice.Post("/transfers/"+id+"/complete", nil, idem)
		status(t, early, 409, "early complete")
		miss := early.Get("error.details.missing").([]any)
		if len(miss) != 1 || miss[0].(float64) != 2 {
			t.Fatalf("missing %v", miss)
		}
		eq(t, put(1, part(1), sha(part(1))).Bool("duplicate"), true, "duplicate flag")
		other := append([]byte(nil), part(1)...)
		other[0] ^= 0xff
		status(t, put(1, other, sha(other)), 409, "different content for same part")
		x.ExpectOK(put(2, part(2), sha(part(2))))
		c1 := x.S.Alice.Post("/transfers/"+id+"/complete", nil, idem)
		c2 := x.S.Alice.Post("/transfers/"+id+"/complete", nil, idem)
		status(t, c1, 200, "complete 1")
		status(t, c2, 200, "complete 2")
		eq(t, c2.Bool("replay"), true, "replay")
		status(t, x.S.Alice.Post("/transfers/"+id+"/complete", nil, map[string]string{"Idempotency-Key": "different-key-1"}), 409, "other key")
		x.Work()
		eq(t, len(x.Mail.To("lead@vnpay.vn")), 1, "approval mails despite double complete")
		status(t, x.S.Alice.Post("/transfers/"+id+"/complete", nil), 400, "no idempotency key")
	})
	t.Run("rejects bad part checksum, wrong size, out-of-range, other users, and a lying whole-file hash", func(t *testing.T) {
		x := newT(t)
		buf := x.content()
		c := x.S.Alice.Post("/transfers", map[string]any{"fileName": "b.zip", "size": len(buf), "sha256": sha(buf), "purpose": "bad part test purpose", "approverId": x.S.Lead.ID})
		id := c.Str("ticket.id")
		put := func(cl *Client, n int, b []byte, shaHex string) *Resp {
			return cl.Req("PUT", fmt.Sprintf("/transfers/%s/parts/%d", id, n), Opt{Raw: b, Headers: map[string]string{"X-Part-SHA256": shaHex}})
		}
		status(t, put(x.S.Alice, 1, buf[:1024], strings.Repeat("f", 64)), 400, "bad checksum")
		status(t, put(x.S.Alice, 1, buf[:100], sha(buf[:100])), 400, "wrong size")
		status(t, put(x.S.Alice, 9, buf[:1024], sha(buf[:1024])), 400, "out of range")
		status(t, put(x.S.Bob, 1, buf[:1024], sha(buf[:1024])), 404, "other user")
		lie := append([]byte(nil), buf...)
		lie[5] ^= 1
		c2 := x.S.Alice.Post("/transfers", map[string]any{"fileName": "l.zip", "size": len(lie), "sha256": sha(buf), "purpose": "lying hash test purpose", "approverId": x.S.Lead.ID})
		id2 := c2.Str("ticket.id")
		for n := 1; n <= 3; n++ {
			end := n * 1024
			if end > len(lie) {
				end = len(lie)
			}
			p := lie[(n-1)*1024 : end]
			x.ExpectOK(x.S.Alice.Req("PUT", fmt.Sprintf("/transfers/%s/parts/%d", id2, n), Opt{Raw: p, Headers: map[string]string{"X-Part-SHA256": sha(p)}}))
		}
		status(t, x.S.Alice.Post("/transfers/"+id2+"/complete", nil, map[string]string{"Idempotency-Key": "key-lying-hash"}), 400, "lying hash")
	})
	t.Run("part body must be octet-stream and bounded", func(t *testing.T) {
		x := newT(t)
		buf := x.content()
		c := x.S.Alice.Post("/transfers", map[string]any{"fileName": "b.zip", "size": len(buf), "sha256": sha(buf), "purpose": "content type test", "approverId": x.S.Lead.ID})
		id := c.Str("ticket.id")
		r := x.S.Alice.Req("PUT", "/transfers/"+id+"/parts/1", Opt{Body: map[string]any{"a": 1}, Headers: map[string]string{"X-Part-SHA256": sha(buf[:1024])}})
		status(t, r, 400, "json body as part")
		big := make([]byte, 1024+1025)
		r = x.S.Alice.Req("PUT", "/transfers/"+id+"/parts/1", Opt{Raw: big, Headers: map[string]string{"X-Part-SHA256": sha(big)}})
		status(t, r, 400, "oversize part")
		eq(t, r.Code(), "VALIDATION", "oversize code")
	})
	t.Run("accepts any extension; still rejects oversize and path-like names", func(t *testing.T) {
		x := newT(t)
		base := func(name string, size int64) map[string]any {
			return map[string]any{"size": size, "sha256": strings.Repeat("a", 64), "purpose": "policy test purpose", "approverId": x.S.Lead.ID, "fileName": name}
		}
		status(t, x.S.Alice.Post("/transfers", base("x.exe", 10)), 201, "exe")
		status(t, x.S.Alice.Post("/transfers", base("../../etc/passwd.zip", 10)), 400, "traversal name")
		status(t, x.S.Alice.Post("/transfers", base("x.zip", 10*1024*1024*1024*1024)), 400, "oversize")
	})
	t.Run("abort deletes parts", func(t *testing.T) {
		x := newT(t)
		r := x.UploadFile(x.S.Alice, Upload{ApproverID: x.S.Lead.ID, Content: x.content(), NoComplete: true})
		status(t, x.S.Alice.Post("/transfers/"+r.TicketID+"/abort", nil), 200, "abort")
		eq(t, x.Deps.Store.Exists(r.TicketID+"/1"), false, "parts deleted")
		eq(t, x.status(x.S.Alice, r.TicketID)["status"].(string), "ABORTED", "status")
	})
}

func TestMalwareScanning(t *testing.T) {
	t.Run("infected file is quarantined, never reaches approval, content purged", func(t *testing.T) {
		x := newT(t)
		x.Scanner.Set(scan.Result{Status: scan.Infected, Signature: "Eicar-Test-Signature"})
		p := x.toPending()
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "QUARANTINED", "status")
		atLeast(t, x.approve(x.S.Lead, p.TicketID), 400, "approve quarantined")
		x.Work()
		eq(t, x.Deps.Store.Exists(p.TicketID+"/1"), false, "purged")
		m := x.Mail.To("alice@vnpay.vn")
		if !strings.Contains(m[len(m)-1].Subject, "mã độc") {
			t.Fatalf("requester not told: %s", m[len(m)-1].Subject)
		}
		eq(t, len(x.Mail.To("lead@vnpay.vn")), 0, "approver bothered")
	})
	t.Run("scanner outage keeps the ticket in SCANNING (never auto-clean) and recovers on retry", func(t *testing.T) {
		x := newT(t)
		x.Scanner.Set(scan.Result{Status: scan.Unavailable, Reason: "clamd down"})
		p := x.toPending()
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "SCANNING", "status")
		atLeast(t, x.approve(x.S.Lead, p.TicketID), 400, "approve while scanning")
		x.Scanner.Set(scan.Result{Status: scan.Clean})
		x.Work()
		eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "PENDING_APPROVAL", "status after retry")
	})
	t.Run("malware found AFTER approval revokes download rights", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		x.ExpectOK(x.approve(x.S.Lead, p.TicketID))
		x.Scanner.Set(scan.Result{Status: scan.Infected, Signature: "Late.Detect"})
		res, err := x.Deps.Tickets.Rescan(context.Background(), p.TicketID)
		if err != nil || res != "quarantined" {
			t.Fatalf("rescan: %q %v", res, err)
		}
		status(t, x.downloadOnce(x.S.Alice, p.TicketID), 403, "download after late detection")
	})
}

func TestEmailNotifications(t *testing.T) {
	t.Run("a scanner outage means no approval email is sent until the file is clean", func(t *testing.T) {
		x := newT(t)
		x.Scanner.Set(scan.Result{Status: scan.Unavailable, Reason: "down"})
		p := x.toPending()
		eq(t, len(x.Mail.All()), 0, "mails during outage")
		x.Scanner.Set(scan.Result{Status: scan.Clean})
		x.Work()
		eq(t, len(x.Mail.To("lead@vnpay.vn")), 1, "approval mail")
		eq(t, x.status(x.S.Alice, p.TicketID)["notifyState"].(string), "SENT", "notifyState")
	})
	t.Run("SMTP down: ticket still reaches PENDING_APPROVAL, notifyState=ERROR is visible, approver can still decide, retry succeeds later", func(t *testing.T) {
		x := newT(t)
		x.Mail.SetFailNext(100)
		p := x.toPending()
		tk := x.status(x.S.Alice, p.TicketID)
		eq(t, tk["status"].(string), "PENDING_APPROVAL", "status")
		eq(t, tk["notifyState"].(string), "ERROR", "notifyState")
		kinds := map[string]bool{}
		for _, e := range x.S.Alice.Get("/transfers/" + p.TicketID).Get("events").([]any) {
			kinds[e.(map[string]any)["kind"].(string)] = true
		}
		if !kinds["email.approval_failed"] {
			t.Fatalf("events %v", kinds)
		}
		found := false
		for _, tk := range x.S.Lead.Get("/transfers?view=approvals").Get("tickets").([]any) {
			if tk.(map[string]any)["id"] == p.TicketID {
				found = true
			}
		}
		if !found {
			t.Fatal("approver cannot find ticket without email")
		}
		x.Mail.SetFailNext(0)
		x.Work(2)
		eq(t, x.status(x.S.Alice, p.TicketID)["notifyState"].(string), "SENT", "notifyState after retry")
		eq(t, len(x.Mail.To("lead@vnpay.vn")), 1, "approval mails")
	})
	t.Run("dead-lettered email jobs stay ERROR until retried", func(t *testing.T) {
		x := newT(t)
		x.Mail.SetFailNext(10_000)
		p := x.toPending()
		x.Exec("UPDATE outbox SET max_attempts=2 WHERE type LIKE 'email.%'")
		x.Work(4)
		if n := Scalar[int](x.Harness, "SELECT count(*)::int FROM outbox WHERE state='dead' AND type='email.approval'"); n != 1 {
			t.Fatalf("dead email.approval jobs: %d", n)
		}
		eq(t, x.status(x.S.Alice, p.TicketID)["notifyState"].(string), "ERROR", "notifyState")
		x.Mail.SetFailNext(0)
		x.Exec("UPDATE outbox SET state='pending', attempts=0, next_run_at=now() WHERE state='dead'")
		x.Work(3)
		eq(t, x.status(x.S.Alice, p.TicketID)["notifyState"].(string), "SENT", "notifyState after revive")
	})
	t.Run("no email when the ticket was already decided before the (retried) job runs", func(t *testing.T) {
		x := newT(t)
		x.Mail.SetFailNext(100)
		p := x.toPending()
		x.ExpectOK(x.S.Lead.Post("/transfers/"+p.TicketID+"/decision", map[string]any{"decision": "reject", "reason": "không đúng yêu cầu"}))
		x.Mail.SetFailNext(0)
		x.Work(3)
		eq(t, len(x.Mail.To("lead@vnpay.vn")), 0, "approver mails")
		m := x.Mail.To("alice@vnpay.vn")
		last := m[len(m)-1]
		if !strings.Contains(last.Subject, "Từ chối") || !strings.Contains(last.Text, "không đúng yêu cầu") {
			t.Fatalf("decision mail: %+v", last)
		}
	})
	t.Run("approval notifies requester and recipients; changing the approver emails the new approver only", func(t *testing.T) {
		x := newT(t)
		r1 := x.toPending(Upload{RecipientIDs: []string{x.S.Bob.ID}})
		x.ExpectOK(x.approve(x.S.Lead, r1.TicketID))
		x.Work()
		bm := x.Mail.To("bob@vnpay.vn")
		if !strings.Contains(bm[len(bm)-1].Subject, "Đã duyệt") {
			t.Fatalf("recipient mail: %s", bm[len(bm)-1].Subject)
		}
		r2 := x.toPending()
		eq(t, len(x.Mail.To("lead2@vnpay.vn")), 0, "lead2 mails before change")
		x.ExpectOK(x.S.Admin.Post("/transfers/"+r2.TicketID+"/change-approver", map[string]any{"approverId": x.S.Lead2.ID}))
		x.Work()
		eq(t, len(x.Mail.To("lead2@vnpay.vn")), 1, "lead2 mails after change")
		n := 0
		for _, m := range x.Mail.To("lead@vnpay.vn") {
			if strings.Contains(m.Subject, r2.Code) {
				n++
			}
		}
		eq(t, n, 1, "old approver mails for r2")
	})
	t.Run("mail content is injection-safe: special characters in file names are HTML-escaped", func(t *testing.T) {
		x := newT(t)
		x.toPending(Upload{Name: `a&b'c.zip`})
		m := x.Mail.To("lead@vnpay.vn")[0]
		if !strings.Contains(m.HTML, "a&amp;b&#39;c.zip") || strings.Contains(m.HTML, "a&b'c") {
			t.Fatalf("html not escaped: %s", m.HTML)
		}
		if strings.ContainsAny(m.Subject, "\r\n") {
			t.Fatal("CR/LF in subject")
		}
	})
	t.Run("non-admins cannot view the audit log", func(t *testing.T) {
		x := newT(t)
		status(t, x.S.Alice.Get("/audit"), 403, "audit as user")
	})
}

func TestDirection(t *testing.T) {
	t.Run("web upload goes office → jump: approved file downloads on the desktop only, never on the web", func(t *testing.T) {
		x := newT(t)
		buf := x.content()
		u := x.UploadFile(x.S.Alice, Upload{ApproverID: x.S.Lead.ID, Content: buf, ViaWeb: true})
		eq(t, u.Ticket["direction"].(string), "OFFICE_TO_JUMP", "direction")
		x.Work()
		if !strings.Contains(x.Mail.To("lead@vnpay.vn")[0].Text, "Office → Jump") {
			t.Fatal("direction missing in approval mail")
		}
		x.ExpectOK(x.approve(x.S.Lead, u.TicketID))
		x.Work()
		am := x.Mail.To("alice@vnpay.vn")
		if !strings.Contains(am[len(am)-1].Text, "máy jump") {
			t.Fatalf("decision mail should point to the jump app: %s", am[len(am)-1].Text)
		}
		web := x.S.Alice.Post("/transfers/"+u.TicketID+"/download-token", nil)
		status(t, web, 403, "web download")
		if !strings.Contains(web.Str("error.message"), "desktop") {
			t.Fatalf("message: %s", web.Str("error.message"))
		}
		dl := x.downloadOnce(x.S.Alice.Desk, u.TicketID)
		status(t, dl, 200, "desktop download")
		if string(dl.Body) != string(buf) {
			t.Fatal("bytes differ")
		}
		for _, e := range x.S.Admin.Get("/audit?limit=200").Get("entries").([]any) {
			m := e.(map[string]any)
			if m["action"] == "transfer.download" {
				d := m["detail"].(map[string]any)
				if d["direction"] != "OFFICE_TO_JUMP" || d["client"] != "desktop" {
					t.Fatalf("detail %v", d)
				}
				return
			}
		}
		t.Fatal("no transfer.download audit entry")
	})
	t.Run("desktop upload goes jump → office: the desktop cannot download it back; token issued on web cannot be redeemed by desktop", func(t *testing.T) {
		x := newT(t)
		p := x.toPending()
		eq(t, p.Ticket["direction"].(string), "JUMP_TO_OFFICE", "direction")
		x.ExpectOK(x.approve(x.S.Lead, p.TicketID))
		status(t, x.S.Alice.Desk.Post("/transfers/"+p.TicketID+"/download-token", nil), 403, "desktop token")
		tok := x.S.Alice.Post("/transfers/"+p.TicketID+"/download-token", nil)
		status(t, tok, 200, "web token")
		status(t, x.S.Alice.Desk.Get(pathOf(tok.Str("url"))), 403, "desktop redeems web token")
		eq(t, x.status(x.S.Alice, p.TicketID)["downloadCount"].(float64), float64(0), "downloadCount")
	})
	t.Run("the client cannot choose the direction", func(t *testing.T) {
		x := newT(t)
		buf := x.content()
		r := x.S.Alice.Desk.Post("/transfers", map[string]any{"fileName": "d.zip", "size": len(buf), "sha256": sha(buf), "purpose": "pick direction", "approverId": x.S.Lead.ID, "direction": "OFFICE_TO_JUMP"})
		status(t, r, 201, "create")
		eq(t, r.Str("ticket.direction"), "JUMP_TO_OFFICE", "direction")
	})
}

func TestMiscRoutes(t *testing.T) {
	x := newT(t)
	t.Run("health", func(t *testing.T) {
		r := x.Anon("GET", "/healthz")
		status(t, r, 200, "healthz")
		eq(t, r.Bool("ok"), true, "ok")
		r = x.Anon("GET", "/readyz")
		status(t, r, 200, "readyz")
		eq(t, r.Bool("db") && r.Bool("storage"), true, "ready flags")
	})
	t.Run("security headers and unknown routes", func(t *testing.T) {
		r := x.Anon("GET", "/healthz")
		eq(t, r.Header.Get("X-Content-Type-Options"), "nosniff", "nosniff")
		eq(t, r.Header.Get("Referrer-Policy"), "no-referrer", "referrer")
		eq(t, r.Header.Get("Cache-Control"), "no-store", "cache-control")
		if r.Header.Get("Strict-Transport-Security") != "" {
			t.Fatal("HSTS must only be sent for https PUBLIC_URL")
		}
		if r.Header.Get("X-Request-ID") == "" {
			t.Fatal("request id missing")
		}
		r = x.Anon("GET", "/api/v1/nope")
		status(t, r, 404, "unknown")
		eq(t, r.Code(), "NOT_FOUND", "code")
	})
	t.Run("request id is echoed when sane and replaced when not", func(t *testing.T) {
		r := x.Anon("GET", "/healthz", Opt{Headers: map[string]string{"X-Request-ID": "abc-123"}})
		eq(t, r.Header.Get("X-Request-ID"), "abc-123", "echo")
		r = x.Anon("GET", "/healthz", Opt{Headers: map[string]string{"X-Request-ID": "bad id with spaces"}})
		if r.Header.Get("X-Request-ID") == "bad id with spaces" {
			t.Fatal("unsafe request id must be replaced")
		}
	})
	t.Run("options, list views and validation", func(t *testing.T) {
		r := x.S.Alice.Get("/transfers/options")
		status(t, r, 200, "options")
		emails := []string{}
		for _, l := range r.Get("leaders").([]any) {
			emails = append(emails, l.(map[string]any)["email"].(string))
		}
		eq(t, strings.Join(emails, ","), "lead@vnpay.vn,lead2@vnpay.vn", "leaders sorted by name")
		eq(t, r.Num("limits.partBytes"), float64(1024), "partBytes")
		eq(t, r.Num("limits.maxDownloads"), float64(3), "maxDownloads")
		status(t, x.S.Alice.Get("/transfers?view=bogus"), 400, "bad view")
		status(t, x.S.Alice.Get("/transfers?view=all"), 403, "all without audit:read")
		status(t, x.S.Admin.Get("/transfers?view=all"), 200, "all as admin")
		status(t, x.S.Alice.Get("/transfers/not-a-uuid"), 404, "bad id")
		status(t, x.S.Alice.Post("/transfers", map[string]any{"fileName": "a"}), 400, "invalid body")
		status(t, x.S.Alice.Post("/transfers", "{not json"), 400, "malformed json")
	})
}

// Exercise production adapter selection, including stale deployment AV settings.
func TestUploadWithoutApplicationAV(t *testing.T) {
	h := harnessWithScanner(t, false, map[string]string{"CLAMD_HOST": "127.0.0.1", "CLAMD_PORT": "1", "DEV_SCAN_CLEAN": "1"})
	x := &tctx{h, h.SeedTransfer()}
	p := x.toPending()
	eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "PENDING_APPROVAL", "AV bypass allows approval")
	detail := x.S.Lead.Get("/transfers/" + p.TicketID)
	sc := detail.Get("scan").(map[string]any)
	eq(t, sc["result"].(string), "skipped", "never report clean")
	eq(t, sc["reason"].(string), "av_disabled", "AV bypass reason")
	eq(t, len(byAction(auditRows(t, x.S.Admin, ""), "transfer.scan_clean")), 0, "no clean audit")
	eq(t, len(byAction(auditRows(t, x.S.Admin, ""), "transfer.scan_skipped")), 1, "skipped audit")
	status(t, x.approve(x.S.Lead, p.TicketID), 200, "approve")
	r := x.downloadOnce(x.S.Alice, p.TicketID)
	status(t, r, 200, "download")
	eq(t, string(r.Body), string(p.Buf), "download bytes")
}
