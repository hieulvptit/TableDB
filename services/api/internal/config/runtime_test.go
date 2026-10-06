package config

import "testing"

func TestRuntimeConfiguration(t *testing.T) {
	c, err := Load(map[string]string{"DB_CONFIG": `{"defaultMaxRows":25,"maxRows":200,"defaultTimeoutSec":10,"pageSize":50}`, "UPLOAD_CLIENT_CONFIG": `{"parallelism":2,"maxRetries":0}`, "DOWNLOAD_TOKEN_TTL_SEC": "120", "DELEGATION_MAX_DAYS": "7"})
	if err != nil {
		t.Fatal(err)
	}
	if c.DB.DefaultMaxRows != 25 || c.DB.MaxRows != 200 || c.DB.PageSize != 50 || c.DB.TablePageSize != 200 || c.UploadClient.Parallelism != 2 || c.UploadClient.MaxRetries != 0 || c.DownloadTokenTTLSec != 120 || c.DelegationMaxDays != 7 {
		t.Fatalf("unexpected runtime config: %+v", c)
	}
	for _, env := range []map[string]string{
		{"DB_CONFIG": `{"maxRows":100001}`}, {"DB_CONFIG": `{"defaultTimeoutSec":601}`}, {"DB_CONFIG": `{"pageSize":0}`},
		{"UPLOAD_CLIENT_CONFIG": `{"parallelism":0}`}, {"UPLOAD_CLIENT_CONFIG": `{"maxRetries":11}`},
		{"DOWNLOAD_TOKEN_TTL_SEC": "0"}, {"DELEGATION_MAX_DAYS": "366"}, {"PART_BYTES": "0"}, {"MAX_UPLOAD_BYTES": "-1"},
		{"TICKET_TTL_HOURS": "NaN"}, {"APPROVAL_WINDOW_HOURS": "Inf"}, {"MAX_DOWNLOADS": "0"},
	} {
		if _, err := Load(env); err == nil {
			t.Errorf("accepted invalid config %v", env)
		}
	}
}
