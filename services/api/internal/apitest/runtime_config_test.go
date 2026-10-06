package apitest

import (
	"testing"
	"time"
)

func TestServerRuntimeSettings(t *testing.T) {
	h := harness(t, map[string]string{"DB_CONFIG": `{"maxRows":2000,"defaultMaxRows":250}`, "UPLOAD_CLIENT_CONFIG": `{"parallelism":2}`, "DOWNLOAD_TOKEN_TTL_SEC": "120", "DELEGATION_MAX_DAYS": "2"})
	u := h.User("alice@vnpay.vn")
	r := u.Get("/db/config")
	status(t, r, 200, "DB runtime settings")
	eq[any](t, r.Get("maxRows"), float64(2000), "configured row limit")
	eq[any](t, r.Get("defaultMaxRows"), float64(250), "configured default")
	r = u.Get("/transfers/options")
	status(t, r, 200, "transfer settings")
	eq[any](t, r.Get("upload").(map[string]any)["parallelism"], float64(2), "upload workers")
	eq[any](t, r.Get("download").(map[string]any)["tokenTtlSec"], float64(120), "download token TTL")
	s := h.SeedTransfer()
	now := time.Now()
	r = s.Lead.Post("/delegations", map[string]any{"toUserId": s.Alice.ID, "validFrom": now.Format(time.RFC3339), "validTo": now.Add(72 * time.Hour).Format(time.RFC3339)})
	status(t, r, 400, "delegation exceeds configured limit")
}
