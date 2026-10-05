// Command auditverify checks an audit export (JSONL from GET /api/v1/audit/export?format=jsonl, or a copy of logs/audit.jsonl)
// offline: it recomputes every row hash, the prevHash linking and the seq contiguity. Exit status 0 = intact.
//
//	auditverify audit-20261002T101500Z.jsonl
//	auditverify - < audit.jsonl
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"vnpay/tabledb-api/internal/audit"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: auditverify <file.jsonl | ->")
		os.Exit(2)
	}
	var r io.Reader = os.Stdin
	if os.Args[1] != "-" {
		f, err := os.Open(os.Args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		defer f.Close()
		r = f
	}
	v, err := audit.VerifyJSONL(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
	if !v.OK {
		os.Exit(1)
	}
}
