import { ApiError } from '../../api/errors';
import { apiClient } from '../../api/client';

export type AuditKind = 'read' | 'write' | 'ddl' | 'other';
/** One executed statement (success or failure). Never carries row data. */
import type { CustomEndpoint } from './custom';

/** A record belongs to a catalog target (`targetId`) or, for db:custom connections, to a hand-entered `custom` endpoint. */
export interface AuditSubject { targetId?: string; custom?: CustomEndpoint }
export type QueryAudit = AuditSubject & { mode: 'read' | 'write'; kind: AuditKind; sql: string; ok: boolean; rows?: number; ms?: number; errorCode?: string };
/** Session lifecycle. */
export type SessionAudit = AuditSubject & { event: 'open' | 'open_failed' | 'close'; authType: string; route?: string };
export interface AuditContext { catalog?: string; schema?: string; table?: string }
export type ActivityAudit = AuditSubject & AuditContext & { event: 'table_view' | 'export'; ok: boolean; sql?: string; format?: string; scope?: 'view' | 'all' | 'selection' | 'cell'; rows?: number; ms?: number; errorCode?: string };
export type AuditRecord = (QueryAudit & AuditContext) | SessionAudit | ActivityAudit;

const MAX_SQL = 65_536;
const KINDS: readonly string[] = ['read', 'write', 'ddl', 'other'];
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined);

/**
 * Explicit whitelist -> wire body for POST /db/audit. Anything not listed (result rows, columns, credentials, ...) is
 * dropped even if a caller passes it; `rows` is only ever a count. The server masks SQL literals.
 */
function subjectBody(x: Record<string, unknown>): Record<string, unknown> {
  const c = x.custom as Partial<CustomEndpoint> | undefined;
  if (!c || typeof c !== 'object') return { targetId: String(x.targetId) };
  return {
    custom: {
      driver: String(c.driver), ...(typeof c.driverName === 'string' ? { driverName: c.driverName.slice(0, 100) } : {}),
      host: String(c.host), port: Number(c.port), ...(typeof c.database === 'string' && c.database ? { database: c.database } : {}),
      ...(c.connectType === 'sid' || c.connectType === 'serviceName' ? { connectType: c.connectType } : {}), allowWrite: c.allowWrite === true,
    },
  };
}

export function toWireBody(r: AuditRecord): Record<string, unknown> {
  const x = r as unknown as Record<string, unknown>;
  const context = Object.fromEntries(['catalog', 'schema', 'table'].flatMap((k) => typeof x[k] === 'string' ? [[k, (x[k] as string).slice(0, 256)]] : []));
  if (x.event === 'table_view' || x.event === 'export') {
    const rows = num(x.rows), ms = num(x.ms);
    return { ...subjectBody(x), ...context, event: x.event, ok: x.ok === true,
      ...(typeof x.sql === 'string' ? { sql: x.sql.slice(0, MAX_SQL) } : {}),
      ...(typeof x.format === 'string' ? { format: x.format.slice(0, 16) } : {}),
      ...(typeof x.scope === 'string' ? { scope: x.scope } : {}),
      ...(rows !== undefined ? { rows } : {}), ...(ms !== undefined ? { ms } : {}),
      ...(typeof x.errorCode === 'string' ? { errorCode: x.errorCode.slice(0, 40) } : {}),
    };
  }
  if (typeof x.event === 'string') {
    return { ...subjectBody(x), event: x.event, authType: String(x.authType), ...(typeof x.route === 'string' && x.route ? { route: x.route.slice(0, 300) } : {}) };
  }
  const rows = num(x.rows), ms = num(x.ms);
  return {
    ...subjectBody(x), ...context,
    mode: x.mode === 'write' ? 'write' : 'read',
    kind: KINDS.includes(x.kind as string) ? x.kind : 'other',
    sql: String(x.sql ?? '').slice(0, MAX_SQL),
    ok: x.ok === true,
    ...(rows !== undefined ? { rows } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(typeof x.errorCode === 'string' && x.errorCode ? { errorCode: x.errorCode.slice(0, 64) } : {}),
  };
}

export interface AuditReporterOptions {
  send?: (body: Record<string, unknown>) => Promise<unknown>;
  maxQueue?: number; baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number;
}

/** Non-retryable: the server understood and refused the record; resending the same body cannot succeed. */
const permanent = (e: unknown) => e instanceof ApiError && [400, 404, 405, 409, 413, 422].includes(e.status);

/**
 * Fire-and-forget audit reporting. `report()` returns immediately and never throws; records are sent one at a time in
 * order, failed sends are retried with exponential backoff (bounded attempts, bounded queue: oldest dropped first).
 * The queue is memory-only on purpose: SQL text is not persisted on the workstation.
 */
export class AuditReporter {
  private queue: Array<{ body: Record<string, unknown>; attempts: number }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private send: (body: Record<string, unknown>) => Promise<unknown>;
  private o: Required<Omit<AuditReporterOptions, 'send'>>;
  dropped = 0;

  constructor(opts: AuditReporterOptions = {}) {
    this.send = opts.send ?? ((body) => apiClient.post('/db/audit', body));
    this.o = { maxQueue: opts.maxQueue ?? 500, baseDelayMs: opts.baseDelayMs ?? 2000, maxDelayMs: opts.maxDelayMs ?? 60_000, maxAttempts: opts.maxAttempts ?? 8 };
  }

  get pending() { return this.queue.length; }

  report(r: AuditRecord): void {
    try {
      this.queue.push({ body: toWireBody(r), attempts: 0 });
      while (this.queue.length > this.o.maxQueue) { this.queue.shift(); this.dropped++; }
      this.schedule(0);
    } catch { /* never affect the UI */ }
  }

  /** Enqueue a body that is already in wire form (agent audit); same retry/queue rules. */
  reportRaw(body: Record<string, unknown>): void {
    try {
      this.queue.push({ body, attempts: 0 });
      while (this.queue.length > this.o.maxQueue) { this.queue.shift(); this.dropped++; }
      this.schedule(0);
    } catch { /* never affect the UI */ }
  }

  private schedule(ms: number) {
    if (this.timer || this.running || this.queue.length === 0) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, ms);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0]!;
        try {
          await this.send(item.body);
          this.queue.shift();
        } catch (e) {
          item.attempts++;
          if (permanent(e) || item.attempts >= this.o.maxAttempts) { this.queue.shift(); this.dropped++; continue; }
          const delay = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (item.attempts - 1));
          this.running = false;
          this.schedule(delay);
          return;
        }
      }
    } finally { this.running = false; }
  }
}

/** Process-wide reporter used by the desktop app. */
export const auditReporter = new AuditReporter();

/** Agent chat audit (metadata only, never prompt/reply text): the Agent runs locally, the server only keeps the trail. */
export const agentAuditReporter = new AuditReporter({ send: (body) => apiClient.post('/agent/audit', body) });
