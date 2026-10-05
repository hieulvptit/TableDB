package tickets

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"

	"vnpay/tabledb-api/internal/pii"
	"vnpay/tabledb-api/internal/scan"
)

type fakeMalware struct {
	status scan.Status
	calls  *int
}

func (f fakeMalware) Scan(_ context.Context, r io.Reader) scan.Result {
	*f.calls++
	_, _ = io.ReadAll(r)
	return scan.Result{Status: f.status}
}

type fakePrivacy struct {
	calls *int
	err   error
}

func (f fakePrivacy) Scan(_ context.Context, _ string, r io.Reader) (pii.Report, error) {
	*f.calls++
	b, _ := io.ReadAll(r)
	if string(b) != "whole file" {
		panic("PII did not receive a fresh stream")
	}
	return pii.Report{Detected: true, Categories: []string{"email"}}, f.err
}
func TestSecurityScanOrderingAndFailure(t *testing.T) {
	for _, status := range []scan.Status{scan.Clean, scan.Skipped, scan.Infected, scan.Unavailable} {
		malwareCalls, privacyCalls, opens := 0, 0, 0
		open := func() (io.Reader, error) { opens++; return strings.NewReader("whole file"), nil }
		r, p, err := assessFile(context.Background(), "x.txt", fakeMalware{status, &malwareCalls}, fakePrivacy{&privacyCalls, nil}, open)
		if err != nil || r.Status != status || malwareCalls != 1 {
			t.Fatal("invalid malware result")
		}
		if status == scan.Clean || status == scan.Skipped {
			if privacyCalls != 1 || opens != 2 || p == nil || !p.Detected {
				t.Fatal("PII stage missing")
			}
		} else if privacyCalls != 0 || opens != 1 || p != nil {
			t.Fatal("PII ran on infected/unavailable file")
		}
	}
	m, p := 0, 0
	verdict, report, err := assessFile(context.Background(), "x.txt", fakeMalware{scan.Clean, &m}, fakePrivacy{&p, fmt.Errorf("unavailable")}, func() (io.Reader, error) { return strings.NewReader("whole file"), nil })
	if err != nil || report == nil || report.Coverage != "unavailable" || verdict.Status != scan.Clean {
		t.Fatal("PII helper failure blocked approval or altered malware verdict")
	}
}

type encryptedPrivacy struct{}

func (encryptedPrivacy) Scan(context.Context, string, io.Reader) (pii.Report, error) {
	return pii.Report{Coverage: "metadata_only", Reason: "encrypted_zip", ListedFiles: 1, EncryptedFiles: 1}, nil
}
func TestEncryptedZipCannotBeReportedClean(t *testing.T) {
	m := 0
	verdict, report, err := assessFile(context.Background(), "secret.zip", fakeMalware{scan.Clean, &m}, encryptedPrivacy{}, func() (io.Reader, error) { return strings.NewReader("whole file"), nil })
	if err != nil || verdict.Status != scan.Skipped || report == nil || report.Coverage != "metadata_only" {
		t.Fatalf("verdict=%+v report=%+v err=%v", verdict, report, err)
	}
}

func TestAVDisabledStillRunsPII(t *testing.T) {
	calls := 0
	verdict, report, err := assessFile(context.Background(), "x.txt", scan.DisabledScanner{}, fakePrivacy{&calls, nil}, func() (io.Reader, error) { return strings.NewReader("whole file"), nil })
	if err != nil || verdict.Status != scan.Skipped || verdict.Reason != "av_disabled" || calls != 1 || report == nil || !report.Detected {
		t.Fatalf("verdict=%+v report=%+v calls=%d err=%v", verdict, report, calls, err)
	}
}
