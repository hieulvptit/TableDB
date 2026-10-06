import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { TableDbProvider, useTableDb, type TableDbApi } from './store';
import { SchemaStore } from './schemaStore';
import type { Connection } from './types';
import { getHistory } from './workspace';

type Fn = ReturnType<typeof vi.fn>;
const res = (over: Record<string, unknown> = {}) => ({ queryId: 'q', kind: 'read', columns: [{ name: 'a', typeName: 'int4' }], rows: [[1]], hasMore: false, truncated: false, elapsedMs: 1, ...over });

function harness(opts: { execute?: Fn; allowWrite?: boolean } = {}) {
  const audit = { report: vi.fn() };
  const execute = opts.execute ?? vi.fn(async (p: { sql: string }) => (/^(UPDATE|DELETE|INSERT)/i.test(p.sql) ? res({ kind: 'write', columns: [], rows: [], updateCount: 2 }) : res()));
  const api = {
    sessionId: 'c1', execute, closeCursor: vi.fn(async () => ({})), cancel: vi.fn(), fetch: vi.fn(),
    setAutoCommit: vi.fn(async (on: boolean) => ({ autoCommit: on, txPending: false })),
    commit: vi.fn(async () => ({ autoCommit: false, txPending: false })), rollback: vi.fn(async () => ({ autoCommit: false, txPending: false })),
    plan: vi.fn(async () => ({ format: 'text', text: 'Seq Scan', elapsedMs: 2 })), setSchema: vi.fn(async (s: string) => s),
  };
  const gateway = { kind: 'tauri', closeSession: vi.fn(async () => {}) };
  const conn = {
    id: 'c1', targetId: 't1', authType: 'password', name: 'PG', driver: 'postgresql', info: { sessionId: 'c1', serverVersion: '16', user: 'u', readOnly: true },
    allowWrite: opts.allowWrite ?? true, api, store: new SchemaStore({} as never), gateway, tx: { autoCommit: true, pending: false },
  } as unknown as Connection;
  let db!: TableDbApi;
  const Grab = () => { db = useTableDb(); return null; };
  const view = render(<ToastProvider><TableDbProvider audit={audit}><Grab /></TableDbProvider></ToastProvider>);
  act(() => db.addConnection(conn));
  return { get db() { return db; }, audit, api, execute, conn, gateway, view };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('run: statement at cursor, script, binds', () => {
  it('runs only the statement it is given (cursor / selection) and remembers its offset', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { sql: 'SELECT 1;\nSELECT 2;' }));
    await act(async () => { await h.db.run(id, { sql: 'SELECT 2', from: 10 }); });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0]).toMatchObject({ sql: 'SELECT 2', mode: 'read' });
    expect(h.db.activeTab!.outputs[0]).toMatchObject({ sql: 'SELECT 2', sqlFrom: 10 });
  });

  it('a database error position becomes an editor offset', async () => {
    const h = harness({ execute: vi.fn(async () => { throw { code: 'E_SQL', message: 'ERROR: column "x" does not exist\n  Position: 8' }; }) });
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.run(id, { sql: 'SELECT x FROM t', from: 10 }); });
    expect(h.db.activeTab!.outputs[0]!.errorPos).toBe(17);
  });

  it('script: reads run, each write waits for its own confirmation, log records everything', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { sql: 'SELECT 1;\nUPDATE t SET a = 1;\nDELETE FROM t;\nSELECT 2', mode: 'write' }));
    let done = false;
    act(() => { void h.db.run(id).then(() => { done = true; }); });
    await flush();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.db.pendingWrite).toMatchObject({ sql: 'UPDATE t SET a = 1', script: { index: 2, total: 4 } });
    await act(async () => { await h.db.confirmWrite(); });
    await flush();
    expect(h.execute.mock.calls[1]![0]).toMatchObject({ sql: 'UPDATE t SET a = 1', mode: 'write', confirmWrite: true });
    expect(h.db.pendingWrite).toMatchObject({ sql: 'DELETE FROM t', script: { index: 3, total: 4 } });
    act(() => h.db.skipWrite());
    await flush(); await flush();
    expect(done).toBe(true);
    expect(h.execute.mock.calls.map((c) => (c[0] as { sql: string }).sql)).toEqual(['SELECT 1', 'UPDATE t SET a = 1', 'SELECT 2']);
    const log = h.db.activeTab!.outputs.find((o) => o.log)!.log!;
    expect(log.map((e) => e.status)).toEqual(['ok', 'ok', 'skipped', 'ok']);
    expect(log[1]).toMatchObject({ updateCount: 2 });
    // result tabs for the two reads + the log
    expect(h.db.activeTab!.outputs.filter((o) => o.result?.columns.length)).toHaveLength(2);
  });

  it('script stops at a write in read mode (never executed) and on Stop', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { sql: 'SELECT 1; DROP TABLE t; SELECT 2' }));
    await act(async () => { await h.db.run(id); });
    expect(h.execute).toHaveBeenCalledTimes(1);
    const log = h.db.activeTab!.outputs.find((o) => o.log)!.log!;
    expect(log.map((e) => e.status)).toEqual(['ok', 'rejected']);
    expect(h.db.activeTab!.activeOutputId).toBe(h.db.activeTab!.outputs.find((o) => o.log)!.id);

    act(() => h.db.updateTab(id, { sql: 'UPDATE t SET a = 1; SELECT 3', mode: 'write' }));
    act(() => { void h.db.run(id); });
    await flush();
    act(() => h.db.dismissWrite());
    await flush(); await flush();
    expect(h.execute).toHaveBeenCalledTimes(1);
    const log2 = h.db.activeTab!.outputs.filter((o) => o.log).at(-1)!.log!;
    expect(log2.map((e) => e.status)).toEqual(['cancelled', 'cancelled']);
  });

  it(':name placeholders are asked for and sent as bind values (audit keeps the written SQL)', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { sql: 'SELECT * FROM t WHERE id = :id AND s = :s' }));
    act(() => { void h.db.run(id); });
    await flush();
    expect(h.db.pendingBinds?.names).toEqual(['id', 's']);
    expect(h.execute).not.toHaveBeenCalled();
    await act(async () => { h.db.resolveBinds({ id: { type: 'number', value: '5' }, s: { type: 'null' } }); });
    await flush();
    expect(h.execute.mock.calls[0]![0]).toMatchObject({ sql: 'SELECT * FROM t WHERE id = ? AND s = ?', params: [{ type: 'number', value: '5' }, { type: 'null' }] });
    expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT * FROM t WHERE id = :id AND s = :s', ok: true }));
    expect(h.db.activeTab!.binds).toMatchObject({ id: { type: 'number', value: '5' } });
    // cancelling the bind dialog runs nothing
    act(() => { void h.db.run(id); });
    await flush();
    expect(h.db.pendingBinds?.values.id).toEqual({ type: 'number', value: '5' }); // remembered
    await act(async () => { h.db.resolveBinds(null); });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('records history for editor runs', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.run(id, { sql: 'SELECT 42', from: 0 }); });
    expect(getHistory()[0]).toMatchObject({ sql: 'SELECT 42', connName: 'PG', ok: true, mode: 'read' });
  });

  it('further result sets become extra result tabs; notices are kept', async () => {
    const h = harness({ execute: vi.fn(async () => res({ messages: ['NOTICE: hi'], moreResults: [{ columns: [{ name: 'b', typeName: 'text' }], rows: [['x']] }, { columns: [], rows: [], updateCount: 3 }] })) });
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.run(id, { sql: 'SELECT p()', from: 0 }); });
    const outs = h.db.activeTab!.outputs;
    expect(outs).toHaveLength(2);
    expect(outs[0]!.result?.messages).toEqual(['NOTICE: hi', 'Kết quả phụ: 3 dòng bị ảnh hưởng.']);
    expect(outs[1]!.result?.rows).toEqual([['x']]);
  });
});

describe('explain, pin, refresh', () => {
  it('explain plans (never executes) into a new output and is audited', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.explain(id, { sql: 'DELETE FROM t', from: 0 }); });
    expect(h.api.plan).toHaveBeenCalledWith('DELETE FROM t', 60);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.db.activeTab!.outputs[0]!.plan).toMatchObject({ format: 'text' });
    expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ sql: 'EXPLAIN DELETE FROM t', mode: 'read', ok: true }));
  });

  it('a pinned output is not refilled by Run; refresh re-runs reads only', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.run(id, { sql: 'SELECT 1', from: 0 }); });
    const first = h.db.activeTab!.outputs[0]!;
    act(() => h.db.patchOutput(id, first.id, { pinned: true }));
    await act(async () => { await h.db.run(id, { sql: 'SELECT 2', from: 0 }); });
    expect(h.db.activeTab!.outputs.map((o) => o.sql)).toEqual(['SELECT 1', 'SELECT 2']);
    await act(async () => { await h.db.refreshOutput(id, first.id); });
    expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({ sql: 'SELECT 1', mode: 'read' });
    expect(h.execute).toHaveBeenCalledTimes(3);
  });
});

describe('transactions', () => {
  it('manual commit: state follows the sidecar; disconnect with pending work asks first', async () => {
    const h = harness({ execute: vi.fn(async () => res({ kind: 'write', columns: [], rows: [], updateCount: 1, autoCommit: false, txPending: true })) });
    await act(async () => { await h.db.setAutoCommit('c1', false); });
    expect(h.api.setAutoCommit).toHaveBeenCalledWith(false);
    expect(h.db.connections[0]!.tx).toEqual({ autoCommit: false, pending: false });
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { mode: 'write' }));
    await act(async () => { await h.db.run(id, { sql: 'UPDATE t SET a = 1', from: 0 }); });
    await act(async () => { await h.db.confirmWrite(); });
    expect(h.db.connections[0]!.tx).toEqual({ autoCommit: false, pending: true });

    await act(async () => { await h.db.removeConnection('c1'); });
    expect(h.gateway.closeSession).not.toHaveBeenCalled();
    expect(h.db.pendingDisconnect?.id).toBe('c1');
    await act(async () => { await h.db.resolveDisconnect('rollback'); });
    expect(h.api.rollback).toHaveBeenCalled();
    expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ sql: 'ROLLBACK', mode: 'write', ok: true }));
    expect(h.gateway.closeSession).toHaveBeenCalledWith('c1');
    expect(h.db.connections).toHaveLength(0);
  });

  it('runWrites(atomic) wraps the batch in one transaction and rolls back on error', async () => {
    let n = 0;
    const h = harness({ execute: vi.fn(async () => { n++; if (n === 2) throw { code: 'E_SQL', message: 'duplicate key' }; return res({ kind: 'write', columns: [], rows: [], updateCount: 1 }); }) });
    let r!: Awaited<ReturnType<TableDbApi['runWrites']>>;
    await act(async () => { r = await h.db.runWrites('c1', ['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)', 'INSERT INTO t VALUES (3)'], { atomic: true }); });
    expect(r).toMatchObject({ done: 0, committed: false, failedIndex: 1 });
    expect(h.api.setAutoCommit.mock.calls).toEqual([[false], [true]]);
    expect(h.api.rollback).toHaveBeenCalledTimes(1);
    expect(h.api.commit).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(2);
    n = 10;
    await act(async () => { r = await h.db.runWrites('c1', ['INSERT INTO t VALUES (4)'], { atomic: true }); });
    expect(r).toMatchObject({ done: 1, committed: true });
    expect(h.api.commit).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({ mode: 'write', confirmWrite: true });
  });
});

describe('tab persistence', () => {
  it('SQL tabs come back (text only) after a restart and bind to the connection', async () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { sql: 'SELECT keep_me' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    h.view.unmount();
    const h2 = harness();
    expect(h2.db.tabs.map((x) => x.sql)).toEqual(['SELECT keep_me']);
    expect(h2.db.tabs[0]!.connId).toBe('c1');
    expect(h2.db.tabs[0]!.outputs).toEqual([]);
  });

  it('tabs of a merged duplicate profile follow the kept profile', () => {
    const h = harness();
    const id = h.db.activeTab!.id;
    act(() => h.db.updateTab(id, { profileId: 'dup' }));
    act(() => h.db.remapProfiles(new Map([['dup', 'keep']])));
    expect(h.db.tabs.find((x) => x.id === id)!.profileId).toBe('keep');
  });
});

it('audits table activation and query with catalog/schema/table context', async () => {
  const h = harness();
  act(() => h.db.openTable({ catalog: 'app', schema: 'public', name: 'orders' }));
  await flush();
  expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'table_view', targetId: 't1', catalog: 'app', schema: 'public', table: 'orders', ok: true }));
  expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ mode: 'read', catalog: 'app', schema: 'public', table: 'orders', ok: true }));
  h.audit.report.mockClear();
  act(() => h.db.openTable({ catalog: 'app', schema: 'public', name: 'orders' }));
  expect(h.audit.report).toHaveBeenCalledOnce();
  expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ event: 'table_view' }));
});
