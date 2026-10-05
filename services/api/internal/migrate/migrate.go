// Package migrate applies the embedded SQL migrations (same schema_migrations semantics as migrate.ts).
package migrate

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"

	"vnpay/tabledb-api/internal/db"
)

//go:embed sql/*.sql
var files embed.FS

// Run applies pending migrations in name order, each in its own transaction; returns the applied names.
func Run(ctx context.Context, p *db.Pool) ([]string, error) {
	// serialize concurrent starters (several API instances booting at once)
	conn, err := p.P.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(727002)"); err != nil {
		return nil, err
	}
	defer conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock(727002)") //nolint:errcheck

	if _, err := p.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return nil, err
	}
	rows, err := p.Query(ctx, "SELECT name FROM schema_migrations")
	if err != nil {
		return nil, err
	}
	done := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		done[n] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	entries, err := files.ReadDir("sql")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	var applied []string
	for _, f := range names {
		if done[f] {
			continue
		}
		b, err := files.ReadFile("sql/" + f)
		if err != nil {
			return applied, err
		}
		err = p.InTx(ctx, func(t db.Runner) error {
			for _, s := range SplitStatements(string(b)) {
				if _, err := t.Exec(ctx, s); err != nil {
					return fmt.Errorf("%s: %w", f, err)
				}
			}
			_, err := t.Exec(ctx, "INSERT INTO schema_migrations (name) VALUES ($1)", f)
			return err
		})
		if err != nil {
			return applied, err
		}
		applied = append(applied, f)
	}
	return applied, nil
}

// SplitStatements splits a migration script into statements, honoring $$…$$ bodies, quotes and -- comments.
func SplitStatements(sql string) []string {
	var out []string
	var cur strings.Builder
	n := len(sql)
	i := 0
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
	}
	for i < n {
		c := sql[i]
		switch {
		case c == '-' && i+1 < n && sql[i+1] == '-':
			for i < n && sql[i] != '\n' {
				i++
			}
		case c == '\'':
			j := i + 1
			for j < n && !(sql[j] == '\'' && !(j+1 < n && sql[j+1] == '\'')) {
				if sql[j] == '\'' {
					j += 2
				} else {
					j++
				}
			}
			end := j + 1
			if end > n {
				end = n
			}
			cur.WriteString(sql[i:end])
			i = j + 1
		case c == '$' && i+1 < n && sql[i+1] == '$':
			end := strings.Index(sql[i+2:], "$$")
			if end < 0 {
				cur.WriteString(sql[i:])
				i = n
			} else {
				e := i + 2 + end + 2
				cur.WriteString(sql[i:e])
				i = e
			}
		case c == ';':
			flush()
			i++
		default:
			cur.WriteByte(c)
			i++
		}
	}
	flush()
	return out
}
