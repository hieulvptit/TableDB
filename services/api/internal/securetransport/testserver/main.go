// Cross-runtime test fixture. Uses fresh disposable signing keys, never deployment secrets.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"time"
	"vnpay/tabledb-api/internal/securetransport"
)

func key() (string, string) {
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		panic(e)
	}
	d := make([]byte, 32)
	k.D.FillBytes(d)
	return base64.StdEncoding.EncodeToString(d), base64.StdEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), k.X, k.Y))
}
func main() {
	desktop, dp := key()
	web, wp := key()
	t, e := securetransport.New(securetransport.Settings{SigningKey: desktop, WebSigningKey: web, Required: true, TTL: time.Minute, MaxSessions: 256, MaxInFlight: 64})
	if e != nil {
		panic(e)
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		panic(e)
	}
	json.NewEncoder(os.Stdout).Encode(map[string]string{"url": "http://" + l.Addr().String() + "/api/v1", "desktop": dp, "web": wp})
	http.Serve(l, t.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/empty" {
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/api/v1/desktop/config" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"ok":true}`)
			return
		}
		w.Header().Set("X-Client-Kind", securetransport.ClientKind(r.Context()))
		w.Header().Set("X-Request-Path", r.URL.RequestURI())
		w.Header().Set("X-Auth", r.Header.Get("Authorization"))
		if r.Method == "GET" {
			if r.URL.Path == "/api/v1/transfers/fixture/download" {
				w.Header().Set("Content-Disposition", "attachment; filename=fixture.bin")
				w.Header().Set("Content-Length", "262144")
			}
			for i := 0; i < 4; i++ {
				w.Write(make([]byte, 65536))
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
			}
			return
		}
		io.Copy(w, r.Body)
	})))
}
