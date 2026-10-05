package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"vnpay/tabledb-api/internal/app"
	"vnpay/tabledb-api/internal/apperr"
)

// GET/HEAD and email preview/link-check requests never record a decision.
// A real browser uses the fragment capability to make a separate POST.
func (h *H) registerEmailApproval(rt *app.Router) {
	rt.GET("/email-approval", app.Opts{Public: true}, func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, err := io.WriteString(w, emailApprovalPage)
		return err
	})
	rt.GET("/email-approval.js", app.Opts{Public: true}, func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, err := io.WriteString(w, emailApprovalScript)
		return err
	})
	rt.POST("/email-approval", app.Opts{Public: true}, func(w http.ResponseWriter, r *http.Request) error {
		public, err := url.Parse(h.D.Cfg.PublicURL)
		if err != nil || public.Host == "" || r.Header.Get("Origin") != public.Scheme+"://"+public.Host {
			return apperr.NewForbidden("same-origin approval request required")
		}
		body, err := app.ReadBody(w, r, 1024)
		if err != nil {
			return err
		}
		var input struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(body, &input); err != nil {
			return apperr.Validation("invalid approval request")
		}
		ticket, err := h.D.Tickets.ApproveFromEmail(r.Context(), input.Token, h.D.ClientIP(r))
		if err != nil {
			return err
		}
		app.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "code": ticket.Code})
		return nil
	})
}

const emailApprovalPage = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Duyệt yêu cầu · TableDB</title><script src="/api/v1/email-approval.js" defer></script></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#17385e"><main style="max-width:480px;margin:12vh auto;padding:32px;background:white;border:1px solid #e2e8f0;border-radius:16px"><p style="font-weight:bold"><span style="color:#07539b">VN</span><span style="color:#e51e36">PAY</span> / TableDB</p><h1 id="title" style="font-size:26px">Đang xử lý phê duyệt…</h1><p id="message" role="status" style="line-height:1.7;color:#475569">Vui lòng đợi trong giây lát.</p><noscript>Trình duyệt cần bật JavaScript để xử lý nút duyệt từ email.</noscript></main></body></html>`

const emailApprovalScript = `(async function(){
 const title=document.getElementById('title'),message=document.getElementById('message');
 const token=location.hash.slice(1);
 history.replaceState(null,'',location.pathname);
 if(!/^[A-Za-z0-9_-]{43}$/.test(token)){title.textContent='Link không hợp lệ';message.textContent='Vui lòng sử dụng nút Duyệt yêu cầu trong email mới nhất.';return;}
 try{
  const response=await fetch(location.pathname,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  if(!response.ok){title.textContent='Không thể duyệt yêu cầu';message.textContent=response.status===403||response.status===409?'Link đã hết hạn, đã được sử dụng hoặc yêu cầu không còn chờ bạn duyệt.':'Hệ thống chưa xử lý được. Vui lòng thử lại từ email.';return;}
  const result=await response.json();
  title.textContent='Đã phê duyệt thành công';
  message.textContent='Yêu cầu '+result.code+' đã được duyệt. Người gửi sẽ nhận được thông báo. Bạn có thể đóng cửa sổ này.';
 }catch(error){title.textContent='Chưa kết nối được hệ thống';message.textContent='Vui lòng kiểm tra kết nối và bấm lại nút duyệt từ email.';}
})();`
