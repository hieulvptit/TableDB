import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { classifySql } from '@vnpay/shared';
import { ToastProvider } from '@vnpay/ui';
import { decideRun } from './runGate';
import { TableDbProvider, useTableDb, type TableDbApi } from './store';
import { SchemaStore } from './schemaStore';
import { WriteConfirmDialog } from './WriteConfirmDialog';
import type { Connection } from './types';

describe('decideRun', () => {
  it.each([
    ['SELECT 1', 'read', true, 'run-read'],
    ['select * from t', 'write', true, 'run-read'],
    ['UPDATE t SET a=1', 'write', true, 'confirm-write'],
    ['DROP TABLE t', 'write', true, 'confirm-write'],
    ['CALL do_it()', 'write', true, 'confirm-write'],
    ['UPDATE t SET a=1', 'read', true, 'reject'],
    ['UPDATE t SET a=1', 'write', false, 'reject'],
    ['SELECT 1; DELETE FROM t', 'write', true, 'reject'],
    ['   ', 'read', true, 'reject'],
    ['SELECT * INTO x FROM t', 'read', true, 'reject'],
  ] as const)('%s [%s, writeAllowed=%s] -> %s', (sql, mode, allowed, action) => {
    expect(decideRun(sql, mode, allowed).action).toBe(action);
  });
});

describe('WriteConfirmDialog', () => {
  it('shows the statement + classification and requires an explicit acknowledgement', async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<WriteConfirmDialog open sql="DELETE FROM orders WHERE id = 1" classification={classifySql('DELETE FROM orders WHERE id = 1')} connectionName="PG" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Câu lệnh sẽ chạy')).toHaveTextContent('DELETE FROM orders WHERE id = 1');
    expect(screen.getByText('GHI')).toBeInTheDocument();
    const run = screen.getByRole('button', { name: 'Chạy câu lệnh' });
    expect(run).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Tôi đã kiểm tra câu lệnh/));
    expect(run).toBeEnabled();
    await userEvent.click(run);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
  it('Cancel is the initial focus and Escape cancels', async () => {
    const onCancel = vi.fn();
    render(<WriteConfirmDialog open sql="DROP TABLE t" classification={classifySql('DROP TABLE t')} onConfirm={() => {}} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'Hủy' })).toHaveFocus();
    expect(screen.getByText('DDL')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});

function harness(execute: ReturnType<typeof vi.fn>, allowWrite: boolean) {
  const audit = { report: vi.fn() };
  const conn = {
    id: 'c1', targetId: 't1', authType: 'password', name: 'PG', driver: 'postgresql', info: { sessionId: 'c1', serverVersion: '16', user: 'u', readOnly: true }, allowWrite,
    api: { execute, closeCursor: vi.fn(), cancel: vi.fn() }, store: new SchemaStore({} as never), gateway: { kind: 'tauri' },
  } as unknown as Connection;
  let api!: TableDbApi;
  const Grab = () => { api = useTableDb(); return null; };
  render(<ToastProvider><TableDbProvider audit={audit}><Grab /></TableDbProvider></ToastProvider>);
  act(() => api.addConnection(conn));
  return { get api() { return api; }, audit };
}
const okResult = { queryId: 'q', kind: 'write', columns: [], rows: [], hasMore: false, truncated: false, elapsedMs: 1, updateCount: 1 };

describe('write gate in the store (execute is never called with mode=write before confirmation)', () => {
  it('write-mode UPDATE opens the confirmation and does NOT execute; confirm executes exactly the shown SQL with confirmWrite:true', async () => {
    const execute = vi.fn(async () => okResult);
    const h = harness(execute, true);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'UPDATE t SET a = 1', mode: 'write' }));
    await act(async () => { await h.api.run(tabId); });
    expect(execute).not.toHaveBeenCalled();
    expect(h.api.pendingWrite).toMatchObject({ sql: 'UPDATE t SET a = 1', classification: { kind: 'write' } });
    // the user edits the editor after the dialog opened: the confirmed statement must still be the shown one
    act(() => h.api.updateTab(tabId, { sql: 'DELETE FROM t' }));
    await act(async () => { await h.api.confirmWrite(); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'UPDATE t SET a = 1', mode: 'write', confirmWrite: true }));
    expect(h.api.pendingWrite).toBeNull();
  });

  it('dismissing the confirmation never executes', async () => {
    const execute = vi.fn(async () => okResult);
    const h = harness(execute, true);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'DROP TABLE t', mode: 'write' }));
    await act(async () => { await h.api.run(tabId); });
    act(() => h.api.dismissWrite());
    await act(async () => { await h.api.confirmWrite(); });
    expect(execute).not.toHaveBeenCalled();
  });

  it('read mode with a write statement is rejected client-side (no execute, friendly error)', async () => {
    const execute = vi.fn(async () => okResult);
    const h = harness(execute, true);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'DELETE FROM t', mode: 'read' }));
    await act(async () => { await h.api.run(tabId); });
    expect(execute).not.toHaveBeenCalled();
    expect(h.api.activeTab?.outputs[0]?.error?.title).toBe('Câu lệnh không phải câu lệnh đọc.');
  });

  it('read statements run in read mode without confirmation and with confirmWrite unset', async () => {
    const execute = vi.fn(async (_p: unknown) => ({ ...okResult, kind: 'read', columns: [{ name: 'a' }], rows: [[1]] }));
    const h = harness(execute, false);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'SELECT 1' }));
    await act(async () => { await h.api.run(tabId); });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'read' }));
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('confirmWrite');
    expect(h.api.pendingWrite).toBeNull();
  });

  it('write mode on a connection that does not allow writes is rejected', async () => {
    const execute = vi.fn(async () => okResult);
    const h = harness(execute, false);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'UPDATE t SET a=1', mode: 'write' }));
    await act(async () => { await h.api.run(tabId); });
    expect(execute).not.toHaveBeenCalled();
    expect(h.api.pendingWrite).toBeNull();
  });

  it('audit: a confirmed write is reported once with raw SQL, mode/kind, ok and row count (no row data)', async () => {
    const execute = vi.fn(async () => okResult);
    const h = harness(execute, true);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: "UPDATE t SET a = 'secret' WHERE id = 7", mode: 'write' }));
    await act(async () => { await h.api.run(tabId); });
    expect(h.audit.report).not.toHaveBeenCalled(); // nothing executed yet => nothing to report
    await act(async () => { await h.api.confirmWrite(); });
    expect(h.audit.report).toHaveBeenCalledTimes(1);
    expect(h.audit.report).toHaveBeenCalledWith({ targetId: 't1', mode: 'write', kind: 'write', sql: "UPDATE t SET a = 'secret' WHERE id = 7", ok: true, rows: 1, ms: 1 });
  });

  it('audit: a failed execution is reported with ok=false and the error code', async () => {
    const execute = vi.fn(async () => { throw { code: 'E_SQL', message: 'relation "x" does not exist', sqlState: '42P01' }; });
    const h = harness(execute, false);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'SELECT * FROM x' }));
    await act(async () => { await h.api.run(tabId); });
    expect(h.audit.report).toHaveBeenCalledWith(expect.objectContaining({ targetId: 't1', mode: 'read', kind: 'read', ok: false, errorCode: 'E_SQL', sql: 'SELECT * FROM x' }));
    expect(h.audit.report.mock.calls[0]![0]).not.toHaveProperty('rows');
  });

  it('audit: client-side rejections (gate) are not executions and are not reported', async () => {
    const execute = vi.fn(async () => okResult);
    const h = harness(execute, true);
    const tabId = h.api.activeTab!.id;
    act(() => h.api.updateTab(tabId, { sql: 'DELETE FROM t', mode: 'read' }));
    await act(async () => { await h.api.run(tabId); });
    expect(h.audit.report).not.toHaveBeenCalled();
  });
});
