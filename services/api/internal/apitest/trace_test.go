package apitest

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/diskguard"
	"vnpay/tabledb-api/internal/scan"
)

func mkZip(t *testing.T, files map[string]string, order []string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, n := range order {
		fw, err := w.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write([]byte(files[n]))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func bundle(t *testing.T) []byte {
	return mkZip(t, map[string]string{
		"people.csv":  "id,name,phone,email\r\n1,An,0912345678,an@example.com\r\n2,Binh,0987654321,binh@example.com\r\n",
		"config.json": `{"a":[1,2,3],"b":{"c":null}}`,
		"note.txt":    "line one\nline two\nline three",
	}, []string{"people.csv", "config.json", "note.txt"})
}

func auditRows(t *testing.T, c *Client, q string) []map[string]any {
	t.Helper()
	r := c.Get("/audit?limit=500" + q)
	status(t, r, 200, "audit list")
	var out []map[string]any
	for _, e := range r.Get("entries").([]any) {
		out = append(out, e.(map[string]any))
	}
	return out
}

func byAction(rows []map[string]any, action string) []map[string]any {
	var out []map[string]any
	for _, r := range rows {
		if r["action"] == action {
			out = append(out, r)
		}
	}
	return out
}

func detail(r map[string]any) map[string]any { d, _ := r["detail"].(map[string]any); return d }

func TestTraceZipEndToEnd(t *testing.T) {
	x := newT(t)
	z := bundle(t)
	// requests carry a User-Agent so the trail can show it
	up := x.S.Alice.Desk
	_ = up
	p := x.toPending(Upload{Content: z, Name: "bundle.zip"})
	id := p.TicketID

	t.Run("detail: uploader, timing, type, scan, manifest", func(t *testing.T) {
		d := x.S.Alice.Get("/transfers/" + id)
		status(t, d, 200, "detail")
		eq(t, d.Str("uploader.email"), "alice@vnpay.vn", "uploader")
		if d.Str("upload.startedAt") == "" || d.Str("upload.completedAt") == "" || d.Get("upload.durationMs") == nil {
			t.Fatalf("upload timing: %v", d.Get("upload"))
		}
		eq(t, d.Str("upload.clientKind"), "desktop", "client kind")
		eq(t, d.Num("upload.parts"), float64(p.TotalParts), "parts")
		if d.Get("upload.clientIp") != nil || d.Get("upload.userAgent") != nil {
			t.Fatal("client ip / ua are for audit:read only")
		}
		eq(t, d.Str("scan.result"), "clean", "scan result")
		eq(t, d.Str("fileType.detected"), "zip", "type")
		eq(t, d.Bool("fileType.mismatch"), false, "mismatch")
		eq(t, d.Str("manifest.status"), "ok", "manifest status")
		eq(t, d.Num("manifest.summary.zip.entryCount"), 3.0, "entries")
		eq(t, d.Bool("manifest.summary.containsSensitivePatterns"), true, "sensitive flag")
		eq(t, d.Num("manifest.summary.sensitive.phone"), 2.0, "phone count")
		eq(t, d.Num("manifest.summary.sensitive.email"), 2.0, "email count")
		eq(t, len(d.Get("manifest.entries.items").([]any)), 3, "items")
		csvE := d.Get("manifest.entries.items.0").(map[string]any)
		eq(t, csvE["path"].(string), "people.csv", "first entry")
		eq(t, csvE["lines"].(float64), 3.0, "csv lines")
		eq(t, csvE["rows"].(float64), 2.0, "csv rows")
		// admin (audit:read) additionally sees network fields
		a := x.S.Admin.Get("/transfers/" + id)
		eq(t, a.Str("upload.clientIp"), "127.0.0.1", "admin sees ip")
		// approver sees the manifest before deciding; an unrelated user sees nothing
		status(t, x.S.Lead.Get("/transfers/"+id+"/manifest"), 200, "approver manifest")
		status(t, x.S.Bob.Get("/transfers/"+id), 404, "unrelated detail")
		status(t, x.S.Bob.Get("/transfers/"+id+"/manifest"), 404, "unrelated manifest")
		status(t, x.S.Bob.Get("/transfers/"+id+"/trace"), 404, "unrelated trace")
	})

	t.Run("manifest paging and hash verification", func(t *testing.T) {
		m := x.S.Lead.Get("/transfers/" + id + "/manifest?offset=1&limit=1&verify=1")
		status(t, m, 200, "page")
		eq(t, len(m.Get("entries.items").([]any)), 1, "page size")
		eq(t, m.Num("entries.total"), 3.0, "total")
		eq(t, m.Get("entries.items.0").(map[string]any)["path"].(string), "config.json", "second entry")
		eq(t, m.Bool("hashVerified"), true, "hash verified")
		status(t, x.S.Lead.Get("/transfers/"+id+"/manifest?limit=9999"), 400, "limit cap")
		// immutable evidence
		for _, q := range []string{"UPDATE ticket_manifests SET status='ok'", "DELETE FROM ticket_manifests", "UPDATE ticket_manifest_entries SET idx=idx", "DELETE FROM ticket_manifest_entries", "TRUNCATE ticket_manifest_entries"} {
			if _, err := x.DB.Exec(context.Background(), q); err == nil || !strings.Contains(err.Error(), "immutable") {
				t.Fatalf("%s must be refused, got %v", q, err)
			}
		}
	})

	d := x.approve(x.S.Lead, id)
	status(t, d, 200, "approve")
	x.Work()
	dl := x.downloadOnce(x.S.Alice, id)
	status(t, dl, 200, "download")
	x.Work()

	rows := auditRows(t, x.S.Admin, "")
	t.Run("audit rows carry who/what/where", func(t *testing.T) {
		for _, a := range []string{"transfer.create", "transfer.upload_started", "transfer.upload_complete", "transfer.scan_clean", "transfer.inspected",
			"transfer.approve", "transfer.download_token", "transfer.download", "transfer.download_completed", "notify.approval_sent"} {
			if len(byAction(rows, a)) == 0 {
				t.Errorf("missing audit action %s", a)
			}
		}
		cr := detail(byAction(rows, "transfer.create")[0])
		eq(t, cr["code"].(string), p.Code, "code")
		eq(t, cr["fileName"].(string), "bundle.zip", "fileName")
		eq(t, cr["declaredSize"].(float64), float64(len(z)), "declared size")
		eq(t, cr["sha256"].(string), sha(z), "sha")
		eq(t, cr["direction"].(string), "JUMP_TO_OFFICE", "direction")
		eq(t, cr["requester"].(map[string]any)["email"].(string), "alice@vnpay.vn", "requester email kept in the trail")
		eq(t, cr["approver"].(map[string]any)["email"].(string), "lead@vnpay.vn", "approver email kept in the trail")
		eq(t, cr["clientKind"].(string), "desktop", "client kind")
		if cr["requestId"] == nil || cr["purpose"] == nil {
			t.Errorf("create detail: %v", cr)
		}
		eq(t, byAction(rows, "transfer.create")[0]["ip"].(string), "127.0.0.1", "ip column")
		up := detail(byAction(rows, "transfer.upload_complete")[0])
		eq(t, up["actualSize"].(float64), float64(len(z)), "actual size")
		eq(t, up["sha256Verified"].(bool), true, "sha verified")
		for _, k := range []string{"uploadStartedAt", "uploadCompletedAt", "uploadDurationMs", "parts"} {
			if up[k] == nil {
				t.Errorf("upload_complete lacks %s: %v", k, up)
			}
		}
		sc := detail(byAction(rows, "transfer.scan_clean")[0])
		eq(t, sc["result"].(string), "clean", "scan result")
		if sc["engine"] == nil || sc["ms"] == nil {
			t.Errorf("scan detail: %v", sc)
		}
		ap := detail(byAction(rows, "transfer.approve")[0])
		eq(t, ap["decision"].(string), "approve", "decision")
		eq(t, ap["decidedBy"].(map[string]any)["email"].(string), "lead@vnpay.vn", "decided by")
		dc := detail(byAction(rows, "transfer.download_completed")[0])
		eq(t, dc["shaMatched"].(bool), true, "sha matched")
		eq(t, dc["bytesSent"].(float64), float64(len(z)), "bytes sent")
		dtk := detail(byAction(rows, "transfer.download_token")[0])
		if _, has := dtk["token"]; has || strings.Contains(fmt.Sprint(dtk), "t=") {
			t.Errorf("token leaked: %v", dtk)
		}
		eq(t, detail(byAction(rows, "transfer.download")[0])["remainingDownloads"].(float64), 2.0, "remaining downloads")
	})

	t.Run("transfer.inspected summarizes and pins the manifest by hash", func(t *testing.T) {
		in := detail(byAction(rows, "transfer.inspected")[0])
		m := x.S.Lead.Get("/transfers/" + id + "/manifest")
		eq(t, in["manifestHash"].(string), m.Str("manifestHash"), "manifest hash in the chain")
		eq(t, in["entryCount"].(float64), 3.0, "entry count")
		eq(t, in["detectedType"].(string), "zip", "type")
		eq(t, in["containsSensitivePatterns"].(bool), true, "sensitive flag")
		eq(t, in["sensitive"].(map[string]any)["phone"].(float64), 2.0, "phone count")
		eq(t, len(in["entries"].([]any)), 3, "inline entries (<= 50)")
		// counts only: no value ever reaches the trail
		all := string(mustMarshal(rows))
		for _, secret := range []string{"0912345678", "0987654321", "an@example.com", "binh@example.com"} {
			if strings.Contains(all, secret) {
				t.Errorf("audit trail leaks content value %q", secret)
			}
		}
	})

	t.Run("trace timeline", func(t *testing.T) {
		tr := x.S.Admin.Get("/transfers/" + id + "/trace")
		status(t, tr, 200, "admin trace")
		es := tr.Get("entries").([]any)
		if len(es) < 9 {
			t.Fatalf("trace has %d entries", len(es))
		}
		var last float64
		for _, e := range es {
			s := e.(map[string]any)["seq"].(float64)
			if s <= last {
				t.Fatal("trace not ordered by seq")
			}
			last = s
		}
		eq(t, tr.Bool("redacted"), false, "admin unredacted")
		rq := x.S.Alice.Get("/transfers/" + id + "/trace")
		status(t, rq, 200, "requester trace")
		eq(t, rq.Bool("redacted"), true, "requester redacted")
		for _, e := range rq.Get("entries").([]any) {
			m := e.(map[string]any)
			if m["ip"] != nil || detail(m)["userAgent"] != nil || detail(m)["sessionRef"] != nil {
				t.Fatalf("network fields leaked to requester: %v", m)
			}
		}
		status(t, x.S.Lead.Get("/transfers/"+id+"/trace"), 200, "approver trace")
	})

	t.Run("audit filters", func(t *testing.T) {
		eq(t, len(auditRows(t, x.S.Admin, "&ticket="+p.Code)) >= 9, true, "ticket code filter")
		eq(t, len(auditRows(t, x.S.Admin, "&resourceId="+id)) >= 9, true, "resourceId filter")
		for _, r := range auditRows(t, x.S.Admin, "&q=ALICE") {
			if !strings.Contains(r["actorLabel"].(string), "alice") {
				t.Fatalf("q filter returned %v", r["actorLabel"])
			}
		}
		eq(t, len(auditRows(t, x.S.Admin, "&actorEmail=nobody-here")), 0, "actorEmail filter")
		status(t, x.S.Admin.Get("/audit?ticket=bad%20code!"), 400, "bad ticket code")
		status(t, x.S.Alice.Get("/audit"), 403, "audit needs audit:read")
	})

	t.Run("export is audited, verifiable offline, and tamper evident", func(t *testing.T) {
		status(t, x.S.Alice.Get("/audit/export"), 403, "needs audit:read")
		status(t, x.S.Admin.Get("/audit/export?format=xml"), 400, "bad format")
		r := x.S.Admin.Get("/audit/export?format=jsonl")
		status(t, r, 200, "export jsonl")
		if !strings.Contains(r.Header.Get("Content-Disposition"), "attachment") || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-ndjson") {
			t.Fatalf("headers: %v", r.Header)
		}
		v, err := audit.VerifyJSONL(bytes.NewReader(r.Body))
		if err != nil || !v.OK || !v.AnchoredAtGenesis || v.Checked < 15 {
			t.Fatalf("offline verify: %+v %v", v, err)
		}
		// flip one byte in a row: verification must point at it
		bad := bytes.Replace(r.Body, []byte(`"bundle.zip"`), []byte(`"bundle.exe"`), 1)
		if v, _ := audit.VerifyJSONL(bytes.NewReader(bad)); v.OK || v.BrokenAtSeq == 0 {
			t.Fatalf("tamper not detected: %+v", v)
		}
		// a deleted row breaks seq contiguity
		lines := bytes.Split(bytes.TrimSpace(r.Body), []byte("\n"))
		cut := bytes.Join(append(append([][]byte{}, lines[:3]...), lines[4:]...), []byte("\n"))
		if v, _ := audit.VerifyJSONL(bytes.NewReader(cut)); v.OK {
			t.Fatalf("missing row not detected: %+v", v)
		}
		csvR := x.S.Admin.Get("/audit/export?format=csv&from=2000-01-01")
		status(t, csvR, 200, "export csv")
		first := strings.SplitN(string(csvR.Body), "\n", 2)[0]
		eq(t, first, "seq,at,actor_id,actor_label,action,resource_type,resource_id,ip,detail,prev_hash,hash", "csv header")
		ex := byAction(auditRows(t, x.S.Admin, "&action=audit.export"), "audit.export")
		if len(ex) < 2 {
			t.Fatalf("exports must be audited, got %d", len(ex))
		}
		eq(t, detail(ex[len(ex)-1])["format"].(string), "jsonl", "export audit detail")
		eq(t, x.S.Admin.Get("/audit/verify").Bool("ok"), true, "chain still verifies after every new event")
	})
}

func mustMarshal(v any) []byte { b, _ := json.Marshal(v); return b }

func TestInspectFailureNeverFailsTheTransfer(t *testing.T) {
	x := newT(t)
	// a scanner that reads the stream, says clean, and then the ciphertext vanishes: the inspector cannot read the file
	x.Deps.Tickets.Scanner = vanishingScanner{dir: x.Cfg.StorageDir}
	p := x.toPending(Upload{Content: bundle(t), Name: "b.zip"})
	eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "PENDING_APPROVAL", "transfer proceeds although inspection failed")
	d := x.S.Alice.Get("/transfers/" + p.TicketID)
	eq(t, d.Str("manifest.status"), "error", "manifest status")
	if d.Str("manifest.inspectError") == "" {
		t.Fatal("inspectError must be recorded")
	}
	rows := auditRows(t, x.S.Admin, "&action=transfer.inspected")
	eq(t, len(rows), 1, "inspected audited even on failure")
	if detail(rows[0])["inspectError"] == nil {
		t.Fatalf("detail: %v", detail(rows[0]))
	}
	eq(t, len(byAction(auditRows(t, x.S.Admin, ""), "transfer.scan_clean")), 1, "scan verdict unaffected")
}

// vanishingScanner reads the whole stream, answers clean, then wipes the file store so the later inspection cannot read the file.
type vanishingScanner struct{ dir string }

func (v vanishingScanner) Scan(_ context.Context, r io.Reader) scan.Result {
	_, _ = io.Copy(io.Discard, r)
	_ = os.RemoveAll(v.dir)
	return scan.Result{Status: scan.Clean}
}

func TestInfectedStillGetsManifest(t *testing.T) {
	x := newT(t)
	x.Scanner.Set(scan.Result{Status: scan.Infected, Signature: "Eicar-Test-Signature"})
	p := x.toPending(Upload{Content: bundle(t), Name: "evil.zip"})
	eq(t, x.status(x.S.Alice, p.TicketID)["status"].(string), "QUARANTINED", "status")
	d := x.S.Alice.Get("/transfers/" + p.TicketID)
	eq(t, d.Str("manifest.status"), "ok", "manifest recorded for infected files too")
	eq(t, d.Str("scan.result"), "infected", "scan")
	eq(t, d.Str("scan.signature"), "Eicar-Test-Signature", "signature")
	rows := auditRows(t, x.S.Admin, "")
	q := byAction(rows, "transfer.quarantine")
	eq(t, len(q), 1, "quarantine audited")
	eq(t, detail(q[0])["signature"].(string), "Eicar-Test-Signature", "signature in trail")
	eq(t, len(byAction(rows, "transfer.inspected")), 1, "inspected audited")
	// ciphertext purged, purge audited
	x.Work()
	eq(t, len(byAction(auditRows(t, x.S.Admin, ""), "storage.purge")), 1, "purge audited")
}

func TestDiskPressureRefusesUploads(t *testing.T) {
	x := newT(t)
	var used uint64 = 50
	total := uint64(1000 << 20)
	g := &diskguard.Guard{LimitPct: 90, ReserveBytes: 10 << 20, Paths: []string{x.Cfg.StorageDir}, StatFn: func(string) (diskguard.Usage, error) {
		u := used << 20 * (total >> 20) / 100 // used% of total
		return diskguard.Usage{Total: total, Used: u, Avail: total - u}, nil
	}}
	x.Deps.Disk, x.Deps.Tickets.Disk = g, g

	create := func(size int) *Resp {
		b := x.Randbytes(size)
		return x.S.Alice.Desk.Post("/transfers", map[string]any{"fileName": "a.bin", "size": size, "sha256": sha(b), "purpose": "purpose text", "approverId": x.S.Lead.ID, "recipientIds": []string{}})
	}
	status(t, create(100), 201, "plenty of room")
	// 88% used + 200 MB declared (x1.1) + reserve would pass the 90% limit even though 88% < 90%
	used = 88
	r := x.S.Alice.Desk.Post("/transfers", map[string]any{"fileName": "big.bin", "size": 200 << 20, "sha256": strings.Repeat("a", 64), "purpose": "purpose text", "approverId": x.S.Lead.ID, "recipientIds": []string{}})
	status(t, r, 507, "admission control uses declared size x1.1 + reserve")
	eq(t, r.Code(), "INSUFFICIENT_STORAGE", "error code")
	// small file still fits at 88%
	status(t, create(100), 201, "small file still admitted")
	// full: every new upload is refused, part uploads too
	b := x.Randbytes(2000)
	ok := x.S.Alice.Desk.Post("/transfers", map[string]any{"fileName": "p.bin", "size": len(b), "sha256": sha(b), "purpose": "purpose text", "approverId": x.S.Lead.ID, "recipientIds": []string{}})
	status(t, ok, 201, "ticket created while there is room")
	used = 96
	status(t, create(10), 507, "create refused when full")
	id := ok.Str("ticket.id")
	part := b[:1024]
	r = x.S.Alice.Desk.Req("PUT", "/transfers/"+id+"/parts/1", Opt{Raw: part, Headers: map[string]string{"X-Part-SHA256": sha(part)}})
	status(t, r, 507, "part upload refused when full")
	// health shows the disk
	h := x.Anon("GET", "/healthz")
	eq(t, h.Str("disk.state"), "warn", "healthz disk state") // not flagged blocked by the janitor yet, but within 5 points
	if h.Num("disk.usedPct") < 95 || h.Num("disk.limitPct") != 90 {
		t.Fatalf("healthz: %s", h.Body)
	}
	// space returns: uploads work again
	used = 40
	status(t, create(10), 201, "uploads resume when space is available")
	_ = filepath.Join
}

func TestAuthTrailFields(t *testing.T) {
	h := harness(t, map[string]string{"TRUST_PROXY": "1"})
	r := h.Anon("POST", "/auth/dev-login", Opt{Body: map[string]any{"email": "carol@vnpay.vn", "name": "Carol"},
		Headers: map[string]string{"User-Agent": "TraceTest/9.9", "X-Forwarded-For": "203.0.113.7, 10.0.0.2", "X-Request-ID": "req-abc-123"}})
	status(t, r, 200, "dev login")
	admin := h.User("admin@vnpay.vn")
	rows := auditRows(t, admin, "&action=auth.login")
	var found map[string]any
	for _, row := range rows {
		if row["actorLabel"] == "carol@vnpay.vn" {
			found = row
		}
	}
	if found == nil {
		t.Fatalf("no login row for carol among %v", rows)
	}
	d := detail(found)
	eq(t, d["userAgent"].(string), "TraceTest/9.9", "user agent")
	eq(t, d["xForwardedFor"].(string), "203.0.113.7, 10.0.0.2", "forwarded chain (TRUST_PROXY=1)")
	eq(t, d["requestId"].(string), "req-abc-123", "request id")
	eq(t, found["ip"].(string), "203.0.113.7", "client ip from XFF")
	eq(t, found["actorLabel"].(string), "carol@vnpay.vn", "actor label keeps the e-mail")

	// without TRUST_PROXY the forwarded chain is not recorded (it would be attacker controlled)
	h2 := harness(t)
	h2.Anon("POST", "/auth/dev-login", Opt{Body: map[string]any{"email": "dave@vnpay.vn", "name": "Dave"}, Headers: map[string]string{"X-Forwarded-For": "1.2.3.4"}})
	a2 := h2.User("admin@vnpay.vn")
	for _, row := range auditRows(t, a2, "&action=auth.login") {
		if row["actorLabel"] == "dave@vnpay.vn" {
			if _, has := detail(row)["xForwardedFor"]; has {
				t.Fatal("X-Forwarded-For recorded without TRUST_PROXY")
			}
		}
	}

	// logout and login_failed carry the same fields; secrets never reach the trail
	c := h.User("erin@vnpay.vn")
	status(t, c.Post("/auth/logout", nil, map[string]string{"User-Agent": "TraceTest/1.0"}), 200, "logout")
	lo := auditRows(t, admin, "&action=auth.logout")
	if len(lo) == 0 || detail(lo[0])["userAgent"] == nil {
		t.Fatalf("logout row: %v", lo)
	}
	secrets := []string{c.CSRF, c.Desk.Bearer, strings.TrimPrefix(c.Cookie, "sid=")}
	all := string(mustMarshal(auditRows(t, admin, "")))
	for _, s := range secrets {
		if s != "" && strings.Contains(all, s) {
			t.Fatalf("a session secret reached the audit trail: %q", s[:6])
		}
	}
}

func TestDecisionReasonIsRedacted(t *testing.T) {
	x := newT(t)
	p := x.toPending()
	reason := "denied, see Bearer abcdefghijklmnopqrstuvwxyz0123 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop pw=secret"
	status(t, x.S.Lead.Post("/transfers/"+p.TicketID+"/decision", map[string]any{"decision": "reject", "reason": reason}), 200, "reject")
	rows := byAction(auditRows(t, x.S.Admin, ""), "transfer.reject")
	eq(t, len(rows), 1, "reject audited")
	s := fmt.Sprint(detail(rows[0]))
	if strings.Contains(s, "abcdefghijklmnopqrstuvwxyz0123") || strings.Contains(s, "eyJhbGci") {
		t.Fatalf("secret in audit detail: %s", s)
	}
	eq(t, detail(rows[0])["decision"].(string), "reject", "decision")
}
