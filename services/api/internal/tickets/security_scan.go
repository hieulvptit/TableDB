package tickets

import (
	"context"
	"io"

	"vnpay/tabledb-api/internal/pii"
	"vnpay/tabledb-api/internal/scan"
)

// assessFile reopens the decrypted stream for each engine. PII never runs on
// malware-positive data. Its errors are advisory and never change the malware verdict.
func assessFile(ctx context.Context, name string, malware scan.Scanner, privacy pii.Checker, open func() (io.Reader, error), privacyOpen ...func() (io.Reader, error)) (scan.Result, *pii.Report, error) {
	r, err := open()
	if err != nil {
		return scan.Result{}, nil, err
	}
	verdict := malware.Scan(ctx, r)
	if (verdict.Status != scan.Clean && verdict.Status != scan.Skipped) || privacy == nil {
		return verdict, nil, nil
	}
	if len(privacyOpen) > 0 {
		open = privacyOpen[0]
	}
	r, err = open()
	if err != nil {
		return verdict, &pii.Report{Engine: "llm-pii", Coverage: "unavailable", Categories: []string{}}, nil
	}
	report, err := privacy.Scan(ctx, name, r)
	if err != nil {
		report.Coverage = "unavailable"
		report.Reason = "helper_unavailable"
		return verdict, &report, nil
	}
	if report.Coverage == "metadata_only" && report.Reason == "encrypted_zip" {
		verdict = scan.Result{Status: scan.Skipped, Reason: "encrypted_zip"}
	}
	return verdict, &report, nil
}
