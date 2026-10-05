package scan

import "testing"

func TestClamdIncompleteScanIsNotMalwareOrClean(t *testing.T) {
	for _, line := range []string{"stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND", "stream: Heuristics.Encrypted.PDF FOUND"} {
		if r := clamdReply(line, nil); r.Status != Unavailable {
			t.Fatalf("incomplete scan verdict: %+v", r)
		}
	}
	if r := clamdReply("stream: Heuristics.Encrypted.Zip FOUND", nil); r.Status != Skipped || r.Reason != "encrypted_zip" {
		t.Fatalf("encrypted ZIP verdict: %+v", r)
	}
	if r := clamdReply("stream: Eicar-Signature FOUND", nil); r.Status != Infected {
		t.Fatalf("real detection lost: %+v", r)
	}
}
