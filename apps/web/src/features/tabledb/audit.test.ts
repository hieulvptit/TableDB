import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { AuditReporter, toWireBody, type QueryAudit } from './audit';

const q = (o: Partial<QueryAudit> = {}): QueryAudit => ({ targetId: 't1', mode: 'read', kind: 'read', sql: 'SELECT 1', ok: true, rows: 1, ms: 5, ...o });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('toWireBody (whitelist)', () => {
  it('never includes row data or unknown fields, even if a caller passes them', () => {
    const evil = { ...q({ rows: 2 }), data: [[1, 'secret']], result: { rows: [[1]] }, columns: ['a'], password: 'pw', token: 't' } as unknown as QueryAudit;
    const b = toWireBody(evil);
    expect(Object.keys(b).sort()).toEqual(['kind', 'mode', 'ms', 'ok', 'rows', 'sql', 'targetId']);
    expect(JSON.stringify(b)).not.toMatch(/secret|pw|"t"/);
    // rows must be a count: arrays / negatives / NaN are dropped
    expect(toWireBody({ ...q(), rows: [[1, 2]] as unknown as number })).not.toHaveProperty('rows');
    expect(toWireBody(q({ rows: -1 }))).not.toHaveProperty('rows');
    expect(toWireBody(q({ rows: Number.NaN }))).not.toHaveProperty('rows');
    expect(toWireBody(q({ rows: 3.7 }))).toHaveProperty('rows', 3);
  });
  it('keeps the documented shapes (query and session events)', () => {
    expect(toWireBody(q({ ok: false, rows: undefined, errorCode: 'E_SQL' }))).toEqual({ targetId: 't1', mode: 'read', kind: 'read', sql: 'SELECT 1', ok: false, ms: 5, errorCode: 'E_SQL' });
    expect(toWireBody({ targetId: 't1', event: 'open_failed', authType: 'password', extra: 1 } as never)).toEqual({ targetId: 't1', event: 'open_failed', authType: 'password' });
  });
  it('custom connections carry a whitelisted endpoint instead of targetId', () => {
    const custom = { driver: 'oracle' as const, host: 'ora.internal', port: 1521, database: 'BISVC', connectType: 'serviceName' as const, allowWrite: false, password: 'pw' };
    const b = toWireBody({ ...q(), targetId: undefined, custom } as never);
    expect(b).not.toHaveProperty('targetId');
    expect(b.custom).toEqual({ driver: 'oracle', host: 'ora.internal', port: 1521, database: 'BISVC', connectType: 'serviceName', allowWrite: false });
    expect(toWireBody({ custom, event: 'open', authType: 'password' } as never)).toEqual({
      custom: { driver: 'oracle', host: 'ora.internal', port: 1521, database: 'BISVC', connectType: 'serviceName', allowWrite: false }, event: 'open', authType: 'password',
    });
  });
  it('normalises mode/kind and caps the SQL length', () => {
    const b = toWireBody(q({ mode: 'weird' as never, kind: 'nope' as never, sql: 'x'.repeat(200_000) }));
    expect(b).toMatchObject({ mode: 'read', kind: 'other' });
    expect((b.sql as string).length).toBe(65_536);
  });
});

describe('AuditReporter', () => {
  it('report() is fire-and-forget: returns synchronously, sends in order, empties the queue', async () => {
    const send = vi.fn(async (_b: Record<string, unknown>) => ({}));
    const r = new AuditReporter({ send });
    r.report(q({ sql: 'A' })); r.report(q({ sql: 'B' }));
    expect(send).not.toHaveBeenCalled(); // nothing awaited on the caller's path
    expect(r.pending).toBe(2);
    await vi.runAllTimersAsync();
    expect(send.mock.calls.map((c) => (c[0] as { sql: string }).sql)).toEqual(['A', 'B']);
    expect(r.pending).toBe(0);
  });

  it('queues while the server is down, retries with exponential backoff and delivers later, preserving order', async () => {
    let up = false;
    const send = vi.fn(async (_b?: Record<string, unknown>) => { if (!up) throw new ApiError('NETWORK', 'down', 0); return {}; });
    const r = new AuditReporter({ send, baseDelayMs: 1000, maxDelayMs: 8000 });
    r.report(q({ sql: 'A' })); r.report(q({ sql: 'B' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);   expect(send).toHaveBeenCalledTimes(2);   // +1s
    await vi.advanceTimersByTimeAsync(2000); expect(send).toHaveBeenCalledTimes(3);  // +2s
    await vi.advanceTimersByTimeAsync(4000); expect(send).toHaveBeenCalledTimes(4);  // +4s
    expect(r.pending).toBe(2);
    up = true;
    await vi.advanceTimersByTimeAsync(8000);
    expect(r.pending).toBe(0);
    expect(send.mock.calls.slice(-2).map((c) => (c as unknown[])[0] as { sql: string }).map((b) => b.sql)).toEqual(['A', 'B']);
  });

  it('drops records the server permanently refuses (4xx validation) but keeps going with the rest', async () => {
    const send = vi.fn(async (b: Record<string, unknown>) => { if (b.sql === 'BAD') throw new ApiError('VALIDATION', 'no', 400); return {}; });
    const r = new AuditReporter({ send });
    r.report(q({ sql: 'BAD' })); r.report(q({ sql: 'OK' }));
    await vi.runAllTimersAsync();
    expect(send.mock.calls.map((c) => c[0].sql)).toEqual(['BAD', 'OK']);
    expect(r.pending).toBe(0); expect(r.dropped).toBe(1);
  });

  it('gives up after maxAttempts and bounds the queue (oldest dropped)', async () => {
    const send = vi.fn(async () => { throw new ApiError('UPSTREAM', 'x', 503); });
    const r = new AuditReporter({ send, maxAttempts: 3, baseDelayMs: 10, maxQueue: 2 });
    r.report(q({ sql: '1' })); r.report(q({ sql: '2' })); r.report(q({ sql: '3' }));
    expect(r.pending).toBe(2); expect(r.dropped).toBe(1);
    await vi.runAllTimersAsync();
    expect(r.pending).toBe(0);
    expect(send).toHaveBeenCalledTimes(6); // 2 records x 3 attempts
  });

  it('never throws into the caller, even with a hostile record', () => {
    const r = new AuditReporter({ send: async () => ({}) });
    expect(() => r.report(null as never)).not.toThrow();
  });
});
