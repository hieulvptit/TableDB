package db

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
)

// Embedded is a real PostgreSQL started from downloaded binaries (replaces PGlite for dev/test).
type Embedded struct {
	pg      *embeddedpostgres.EmbeddedPostgres
	URL     string // postgres://… to the "postgres" database
	Port    uint32
	dataDir string
	cleanup bool
}

// FreePort asks the OS for an unused TCP port.
func FreePort() (uint32, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return uint32(l.Addr().(*net.TCPAddr).Port), nil
}

// StartEmbedded boots PostgreSQL. dataDir=="" uses a throw-away temp dir removed by Stop; otherwise the directory is
// kept (persistent dev data, the PGLITE_DIR equivalent). logger receives postgres output (io.Discard to silence).
func StartEmbedded(dataDir string, logger io.Writer) (*Embedded, error) {
	port, err := FreePort()
	if err != nil {
		return nil, err
	}
	cleanup := false
	if dataDir == "" {
		dataDir, err = os.MkdirTemp("", "tabledb-pg-*")
		if err != nil {
			return nil, err
		}
		cleanup = true
	} else if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	abs, _ := filepath.Abs(dataDir)
	if logger == nil {
		logger = io.Discard
	}
	cfg := embeddedpostgres.DefaultConfig().
		Port(port).
		DataPath(filepath.Join(abs, "data")).
		RuntimePath(filepath.Join(abs, "runtime")).
		Username("postgres").Password("postgres").Database("postgres").
		StartTimeout(120 * time.Second).
		Logger(logger)
	pg := embeddedpostgres.NewDatabase(cfg)
	if err := pg.Start(); err != nil {
		if cleanup {
			_ = os.RemoveAll(abs)
		}
		return nil, fmt.Errorf("start embedded postgres: %w", err)
	}
	return &Embedded{pg: pg, Port: port, dataDir: abs, cleanup: cleanup,
		URL: fmt.Sprintf("postgres://postgres:postgres@127.0.0.1:%d/postgres?sslmode=disable", port)}, nil
}

// URLFor returns the connection URL for another database on the same server.
func (e *Embedded) URLFor(dbname string) string {
	return fmt.Sprintf("postgres://postgres:postgres@127.0.0.1:%d/%s?sslmode=disable", e.Port, dbname)
}

// Stop shuts postgres down cleanly (and removes the data dir if it was temporary).
func (e *Embedded) Stop() error {
	err := e.pg.Stop()
	if e.cleanup {
		_ = os.RemoveAll(e.dataDir)
	}
	return err
}
