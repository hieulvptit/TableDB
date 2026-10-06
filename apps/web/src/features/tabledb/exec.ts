import { dbRuntimeConfig } from './runtimeConfig';
import { classifySql } from '@vnpay/shared';
import { uid } from '../../lib';
import { auditReporter, type AuditReporter } from './audit';
import { friendlyDbError, type FriendlyError } from './dbErrors';
import type { Connection } from './types';

export interface Grid { columns: string[]; rows: unknown[][]; truncated: boolean }


const subject = (conn: Connection) => (conn.custom ? { custom: conn.custom } : { targetId: conn.targetId });

/** Runs a statement on the session exactly like the editor would, including the audit record (counts/timing only). */
export async function runAudited(conn: Connection, sql: string, mode: 'read' | 'write', opts: { maxRows?: number; all?: boolean; cancelled?: () => boolean; timeoutSec?: number; lobLimit?: number; audit?: Pick<AuditReporter, 'report'> } = {}): Promise<Grid & { updateCount?: number; typeNames: string[]; txPending?: boolean; autoCommit?: boolean }> {
  const started = Date.now();
  const audit = opts.audit ?? auditReporter;
  const report = (ok: boolean, extra: { rows?: number; errorCode?: string }) =>
    audit.report({ ...subject(conn), mode, kind: classifySql(sql).kind, sql, ok, ms: Date.now() - started, ...extra });
  try {
    const r = await conn.api.execute({
      queryId: uid(), sql, mode, ...(mode === 'write' ? { confirmWrite: true } : {}), maxRows: opts.maxRows ?? dbRuntimeConfig().defaultMaxRows, timeoutSec: opts.timeoutSec ?? dbRuntimeConfig().defaultTimeoutSec, pageSize: dbRuntimeConfig().pageSize,
      ...(opts.lobLimit ? { lobLimit: opts.lobLimit } : {}),
    });
    const rows: unknown[][] = [];
    for (const x of r.rows ?? []) rows.push(x);
    let hasMore = r.hasMore, truncated = r.truncated;
    while (opts.all && hasMore && r.cursorId && !opts.cancelled?.()) {
      const p = await conn.api.fetch(r.cursorId, dbRuntimeConfig().pageSize);
      for (const x of p.rows) rows.push(x);
      hasMore = p.hasMore; truncated = p.truncated;
    }
    if (hasMore && r.cursorId) void conn.api.closeCursor(r.cursorId).catch(() => {});
    report(true, { rows: r.updateCount ?? rows.length });
    return { columns: r.columns.map((c) => c.name), typeNames: r.columns.map((c) => c.typeName), rows, truncated: truncated || hasMore, updateCount: r.updateCount, txPending: r.txPending, autoCommit: r.autoCommit };
  } catch (e) {
    report(false, { errorCode: friendlyDbError(e).code });
    throw e;
  }
}

/** COMMIT / ROLLBACK are reported like statements (the server sees what ended a transaction). */
export function reportTx(conn: Connection, what: 'COMMIT' | 'ROLLBACK', ok: boolean, ms: number, audit: Pick<AuditReporter, 'report'> = auditReporter, errorCode?: string) {
  audit.report({ ...subject(conn), mode: 'write', kind: 'other', sql: what, ok, ms, ...(errorCode ? { errorCode } : {}) });
}

export interface WriteBatchResult { done: number; committed: boolean; pending: boolean; error?: FriendlyError; failedIndex?: number }

/**
 * Runs several write statements. `atomic`: in auto-commit mode the session is switched to manual commit for the batch,
 * committed at the end and rolled back on the first error (then switched back). A session already in manual mode keeps
 * the user's transaction open: nothing is committed here.
 */
export async function runWriteBatch(conn: Connection, stmts: string[], opts: { atomic: boolean; onProgress?: (done: number) => void; stop?: () => boolean; audit?: Pick<AuditReporter, 'report'> }): Promise<WriteBatchResult> {
  const manual = conn.tx ? !conn.tx.autoCommit : false;
  const own = opts.atomic && !manual;
  let done = 0;
  if (own) await conn.api.setAutoCommit(false);
  try {
    for (let i = 0; i < stmts.length; i++) {
      if (opts.stop?.()) break;
      try {
        await runAudited(conn, stmts[i]!, 'write', { audit: opts.audit });
      } catch (e) {
        const error = friendlyDbError(e);
        if (own) {
          const t0 = Date.now();
          try { await conn.api.rollback(); reportTx(conn, 'ROLLBACK', true, Date.now() - t0, opts.audit); } catch (re) { reportTx(conn, 'ROLLBACK', false, Date.now() - t0, opts.audit, friendlyDbError(re).code); }
          return { done: 0, committed: false, pending: false, error, failedIndex: i };
        }
        return { done, committed: false, pending: manual, error, failedIndex: i };
      }
      done++;
      opts.onProgress?.(done);
    }
    if (own) {
      const t0 = Date.now();
      if (opts.stop?.()) { await conn.api.rollback(); reportTx(conn, 'ROLLBACK', true, Date.now() - t0, opts.audit); return { done: 0, committed: false, pending: false }; }
      try { await conn.api.commit(); reportTx(conn, 'COMMIT', true, Date.now() - t0, opts.audit); } catch (e) {
        reportTx(conn, 'COMMIT', false, Date.now() - t0, opts.audit, friendlyDbError(e).code);
        try { await conn.api.rollback(); } catch { /* already ended */ }
        return { done: 0, committed: false, pending: false, error: friendlyDbError(e) };
      }
      return { done, committed: true, pending: false };
    }
    return { done, committed: !manual, pending: manual && done > 0 };
  } finally {
    if (own) { try { await conn.api.setAutoCommit(true); } catch { /* the session reports its state on the next statement */ } }
  }
}
