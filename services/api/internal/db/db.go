// Package db wraps pgx/v5: a pool, a transaction helper, and an embedded PostgreSQL for dev/test.
package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Querier is satisfied by the pool and by a transaction.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Runner is a Querier that can run a function in a transaction. Inside a transaction InTx simply reuses it
// (like the Node `tx: (fn) => fn(handle)`), so services can be composed without caring whether they are already in one.
type Runner interface {
	Querier
	InTx(ctx context.Context, fn func(Runner) error) error
}

// Pool is the production Runner.
type Pool struct{ P *pgxpool.Pool }

func Open(ctx context.Context, url string) (*Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 10
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := p.Ping(ctx); err != nil {
		p.Close()
		return nil, fmt.Errorf("connect database: %w", err)
	}
	return &Pool{P: p}, nil
}

func (p *Pool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return p.P.Query(ctx, sql, args...)
}
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return p.P.QueryRow(ctx, sql, args...)
}
func (p *Pool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return p.P.Exec(ctx, sql, args...)
}
func (p *Pool) Close() { p.P.Close() }

func (p *Pool) InTx(ctx context.Context, fn func(Runner) error) error {
	tx, err := p.P.Begin(ctx)
	if err != nil {
		return err
	}
	if err := fn(&txRunner{tx}); err != nil {
		// detach from the request context so a cancelled request still rolls back
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return err
	}
	return tx.Commit(ctx)
}

type txRunner struct{ tx pgx.Tx }

func (t *txRunner) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return t.tx.Query(ctx, sql, args...)
}
func (t *txRunner) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.tx.QueryRow(ctx, sql, args...)
}
func (t *txRunner) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.tx.Exec(ctx, sql, args...)
}
func (t *txRunner) InTx(ctx context.Context, fn func(Runner) error) error { return fn(t) }

// Tx runs fn in a transaction and returns its value.
func Tx[T any](ctx context.Context, r Runner, fn func(Runner) (T, error)) (T, error) {
	var out T
	err := r.InTx(ctx, func(t Runner) error {
		v, err := fn(t)
		out = v
		return err
	})
	return out, err
}

// IsNoRows reports whether err is pgx.ErrNoRows.
func IsNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
