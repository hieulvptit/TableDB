// Approval emails contain a scoped, expiring, single-use approval link.
// Other notifications link to BO; file download still requires authenticated access.
package mail

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"vnpay/tabledb-api/internal/shared"
)

var escMap = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

func esc(s string) string { return escMap.Replace(s) }

func clip(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) > n {
		return string(utf16.Decode(u[:n])) + "…"
	}
	return s
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func fmtSize(n int64) string {
	const k = 1024
	switch {
	case n >= k*k*k:
		return fmt.Sprintf("%.2f GB", float64(n)/(k*k*k))
	case n >= k*k:
		return fmt.Sprintf("%.1f MB", float64(n)/(k*k))
	default:
		return fmt.Sprintf("%d KB", (n+k-1)/k)
	}
}

type Person struct{ Name, Email string }

type TicketMailData struct {
	Code, FileName string
	Size           int64
	SHA256         string
	Purpose        string
	Direction      shared.TransferDirection
	Requester      Person
	Approver       Person
	Link           string
	ApprovalLink   string
	ExpiresAt      string
	Reason         string
	Signature      string
}

const footerText = "Đăng nhập BO bằng SSO để xem chi tiết. Mọi quyết định phê duyệt và tải file đều được thực hiện trong hệ thống."

type mailStyle struct{ title, status, color, tint, greeting string }

// digestHTML allows long checksums to wrap in email clients without relying on CSS.
func digestHTML(value string) string {
	var chunks []string
	for len(value) > 8 {
		chunks = append(chunks, esc(value[:8]))
		value = value[8:]
	}
	chunks = append(chunks, esc(value))
	return strings.Join(chunks, "&#8203;")
}

func friendlyTime(value string) string {
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t.In(time.FixedZone("GMT+7", 7*60*60)).Format("15:04 · 02/01/2006") + " (GMT+7)"
	}
	return value
}

func render(subject, intro string, d TicketMailData, extra []string, cta string, style mailStyle) (string, string, string) {
	footer := footerText
	actionLink := d.Link
	if d.ApprovalLink != "" {
		actionLink = d.ApprovalLink
		footer = "Bấm Duyệt yêu cầu để phê duyệt ngay. Link dành riêng cho người duyệt, dùng một lần và có hiệu lực tối đa 24 giờ (không vượt quá hạn duyệt). Không chuyển tiếp email này."
	}
	rows := [][2]string{
		{"Mã yêu cầu", d.Code}, {"Chiều chuyển", shared.DirectionLabelVI[d.Direction]},
		{"Người gửi", fmt.Sprintf("%s <%s>", oneLine(d.Requester.Name), d.Requester.Email)},
		{"Người duyệt", fmt.Sprintf("%s <%s>", oneLine(d.Approver.Name), d.Approver.Email)},
		{"Tên file", oneLine(d.FileName)}, {"Kích thước", fmtSize(d.Size)},
		{"Mục đích", clip(oneLine(d.Purpose), 500)}, {"SHA-256", d.SHA256},
	}
	greeting := "Xin chào"
	if name := oneLine(style.greeting); name != "" {
		greeting += " " + name
	}
	lines := []string{greeting + ",", "", style.title, intro, ""}
	for _, r := range rows {
		lines = append(lines, r[0]+": "+r[1])
	}
	lines = append(lines, extra...)
	if d.ApprovalLink != "" {
		lines = append(lines, "Xem chi tiết yêu cầu: "+d.Link)
	}
	lines = append(lines, "", cta+": "+actionLink, "", footer, "Email tự động từ VNPAY TableDB. Vui lòng không trả lời email này.")
	text := strings.Join(lines, "\n")
	var h strings.Builder
	h.WriteString(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>` + esc(subject) + `</title><style>@media only screen and (max-width:600px){.outer{padding:16px 8px!important}.content{padding:28px 22px!important}.brand{padding:22px!important}.headline{font-size:26px!important}.action{display:block!important;text-align:center!important}.label{width:96px!important}}</style></head><body style="margin:0;padding:0;background-color:#f1f5f9;color:#172b4d;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">`)
	h.WriteString(`<div style="display:none;font-size:1px;color:#f1f5f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">` + esc(style.title+" · "+d.Code+" · "+oneLine(d.FileName)) + `</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9"><tr><td class="outer" align="center" style="padding:40px 16px">`)
	h.WriteString(`<!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;border-collapse:separate"><tr><td class="brand" style="padding:26px 36px;border-bottom:1px solid #e8eef5"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:22px;font-weight:800;letter-spacing:-1px"><span style="color:#07539b">VN</span><span style="color:#e51e36">PAY</span><span style="color:#cbd5e1;font-weight:400;margin:0 12px"> / </span><span style="font-size:18px;font-weight:600;letter-spacing:0;color:#172b4d">TableDB</span></td><td align="right" style="font-size:10px;font-weight:700;letter-spacing:1px;color:#64748b">CHUYỂN FILE</td></tr></table></td></tr><tr><td class="content" style="padding:36px">`)
	h.WriteString(`<span style="display:inline-block;padding:7px 11px;border-radius:6px;background-color:` + style.tint + `;color:` + style.color + `;font-size:12px;font-weight:700;line-height:18px">` + esc(style.status) + `</span><h1 class="headline" style="margin:18px 0 8px;font-size:30px;line-height:1.25;letter-spacing:-0.6px;font-weight:700;color:#142c48">` + esc(style.title) + `</h1><p style="margin:0 0 24px;font-size:13px;line-height:20px;color:#64748b">Yêu cầu <span style="font-weight:700;color:#334155">` + esc(d.Code) + `</span></p>`)
	h.WriteString(`<p style="margin:0 0 8px;font-size:15px;line-height:24px;font-weight:700">` + esc(greeting) + `,</p><p style="margin:0 0 24px;font-size:15px;line-height:25px;color:#475569">` + esc(intro) + `</p>`)
	h.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px"><tr><td style="padding:20px"><p style="margin:0 0 8px;font-size:10px;line-height:16px;letter-spacing:1.1px;font-weight:700;color:#64748b">FILE CHUYỂN</p><p style="margin:0 0 7px;font-size:17px;line-height:26px;font-weight:700;color:#17385e;word-break:break-all;overflow-wrap:anywhere">` + esc(oneLine(d.FileName)) + `</p><p style="margin:0;font-size:13px;line-height:20px;color:#64748b">` + esc(fmtSize(d.Size)) + ` &nbsp; · &nbsp; ` + esc(shared.DirectionLabelVI[d.Direction]) + `</p></td></tr></table>`)
	if purpose := clip(oneLine(d.Purpose), 500); purpose != "" {
		h.WriteString(`<p style="margin:24px 0 6px;font-size:12px;font-weight:700;line-height:18px;color:#64748b">MỤC ĐÍCH CHUYỂN FILE</p><p style="margin:0 0 24px;font-size:14px;line-height:23px;color:#334155;word-break:break-word">` + esc(purpose) + `</p>`)
	}
	h.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">`)
	for _, person := range []struct {
		label string
		value Person
	}{{"Người gửi", d.Requester}, {"Người duyệt", d.Approver}} {
		h.WriteString(`<tr><td class="label" width="112" valign="top" style="padding:10px 12px 10px 0;font-size:13px;line-height:21px;color:#64748b;border-bottom:1px solid #eef2f6">` + person.label + `</td><td style="padding:10px 0;border-bottom:1px solid #eef2f6;font-size:14px;line-height:21px;color:#334155"><strong>` + esc(oneLine(person.value.Name)) + `</strong><br><span style="font-size:12px;color:#64748b;word-break:break-all">` + esc(person.value.Email) + `</span></td></tr>`)
	}
	h.WriteString(`</table>`)
	for _, e := range extra {
		label, value, ok := strings.Cut(e, ": ")
		if !ok {
			label, value = "Thông tin", e
		}
		h.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background-color:` + style.tint + `;border-radius:8px"><tr><td style="padding:16px 18px;border-left:3px solid ` + style.color + `"><p style="margin:0 0 5px;font-size:12px;line-height:18px;font-weight:700;color:` + style.color + `">` + esc(label) + `</p><p style="margin:0;font-size:14px;line-height:23px;color:#334155;word-break:break-word">` + esc(value) + `</p></td></tr></table>`)
	}
	h.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px"><tr><td bgcolor="#07539b" style="border-radius:8px;mso-padding-alt:15px 24px"><a class="action" href="` + esc(actionLink) + `" style="display:inline-block;padding:15px 24px;background-color:#07539b;border:1px solid #07539b;border-radius:8px;color:#ffffff;font-size:14px;font-weight:700;line-height:20px;text-decoration:none;mso-padding-alt:0">` + esc(cta) + ` &nbsp; &#8594;</a></td></tr></table><p style="margin:14px 0 0;font-size:12px;line-height:19px;color:#64748b">` + esc(footer) + `</p>`)
	if d.ApprovalLink != "" {
		h.WriteString(`<p style="margin:12px 0 0;font-size:13px;line-height:20px"><a href="` + esc(d.Link) + `" style="color:#07539b;text-decoration:underline">Xem chi tiết yêu cầu</a></p>`)
	}
	if d.SHA256 != "" {
		h.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;border-top:1px solid #e8eef5"><tr><td style="padding-top:18px"><p style="margin:0 0 5px;font-size:10px;line-height:16px;letter-spacing:0.6px;color:#94a3b8">MÃ KIỂM TRA FILE · SHA-256</p><p style="margin:0;font-family:Consolas,'Courier New',monospace;font-size:10px;line-height:17px;color:#94a3b8;word-break:break-all;overflow-wrap:anywhere">` + digestHTML(d.SHA256) + `</p></td></tr></table>`)
	}
	h.WriteString(`</td></tr></table><!--[if mso]></td></tr></table><![endif]--><p style="margin:20px 0 4px;font-size:12px;line-height:20px;color:#64748b;font-weight:700">VNPAY TableDB</p><p style="margin:0;font-size:11px;line-height:18px;color:#94a3b8">Email tự động. Vui lòng không trả lời email này.</p></td></tr></table></body></html>`)
	return subject, text, h.String()
}

func build(to []string, subject, text, html string) Mail {
	return Mail{To: to, Subject: subject, Text: text, HTML: html}
}

func ApprovalRequestMail(d TicketMailData, to []string) Mail {
	var extra []string
	if d.ExpiresAt != "" {
		extra = append(extra, "Vui lòng duyệt trước: "+friendlyTime(d.ExpiresAt))
	}
	s, t, h := render(fmt.Sprintf("[%s] Yêu cầu phê duyệt chuyển file: %s", d.Code, clip(oneLine(d.FileName), 80)),
		fmt.Sprintf("%s gửi bạn một yêu cầu chuyển file. Bạn có thể bấm Duyệt yêu cầu bên dưới để phê duyệt ngay, hoặc xem chi tiết nếu cần thêm thông tin.", oneLine(d.Requester.Name)),
		d, extra, "Duyệt yêu cầu", mailStyle{"Có yêu cầu cần bạn duyệt", "CHỜ PHÊ DUYỆT", "#07539b", "#edf5ff", d.Approver.Name})
	return build(to, s, t, h)
}

func DecisionMail(d TicketMailData, to []string, approved bool) Mail {
	d.ApprovalLink = ""
	var subj, intro, cta string
	style := mailStyle{"Yêu cầu chưa được duyệt", "ĐÃ TỪ CHỐI", "#b45309", "#fff7ed", d.Requester.Name}
	var extra []string
	if approved {
		style = mailStyle{"File đã sẵn sàng", "ĐÃ PHÊ DUYỆT", "#15803d", "#edf9f0", d.Requester.Name}
		subj = fmt.Sprintf("[%s] %s: %s", d.Code, shared.StatusLabelVI[shared.StatusApproved], clip(oneLine(d.FileName), 80))
		where := "trên cổng BO"
		cta = "Tải file trên BO"
		if d.Direction == shared.OfficeToJump {
			where = "trên ứng dụng TableDB desktop ở máy jump"
			cta = "Xem chi tiết trên BO"
		}
		intro = fmt.Sprintf("Yêu cầu chuyển file đã được duyệt. Bạn có thể tải file %s (cần đăng nhập lại).", where)
		if d.ExpiresAt != "" {
			extra = append(extra, "Tải file trước: "+friendlyTime(d.ExpiresAt))
		}
	} else {
		subj = fmt.Sprintf("[%s] %s: %s", d.Code, shared.StatusLabelVI[shared.StatusRejected], clip(oneLine(d.FileName), 80))
		intro = "Người duyệt chưa chấp thuận yêu cầu chuyển file này. Bạn có thể xem lý do bên dưới và gửi yêu cầu mới sau khi điều chỉnh."
		cta = "Xem chi tiết trên BO"
		extra = append(extra, "Lý do: "+clip(oneLine(d.Reason), 500))
	}
	s, t, h := render(subj, intro, d, extra, cta, style)
	return build(to, s, t, h)
}

func QuarantineMail(d TicketMailData, to []string) Mail {
	d.ApprovalLink = ""
	sig := d.Signature
	if sig == "" {
		sig = "không rõ"
	}
	s, t, h := render(fmt.Sprintf("[%s] File bị cách ly do phát hiện mã độc", d.Code),
		"Công cụ quét phát hiện mã độc trong file này. Hệ thống đã chặn chuyển file và yêu cầu không thể được duyệt. Vui lòng kiểm tra lại file nguồn trước khi gửi yêu cầu mới.", d,
		[]string{"Kết quả kiểm tra: " + clip(oneLine(sig), 100)}, "Xem chi tiết trên BO", mailStyle{"File đã bị chặn", "PHÁT HIỆN MÃ ĐỘC", "#b91c1c", "#fff1f2", d.Requester.Name})
	return build(to, s, t, h)
}
