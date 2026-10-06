// Generates an independent P-256 server signing key. Redirect output to a secret file.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
)

func main() {
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		panic(e)
	}
	d := make([]byte, 32)
	k.D.FillBytes(d)
	json.NewEncoder(os.Stdout).Encode(map[string]string{"privateKey": base64.StdEncoding.EncodeToString(d), "publicKey": base64.StdEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), k.X, k.Y))})
}
