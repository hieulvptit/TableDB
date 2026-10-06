import { auditReporter } from './audit';
import * as downloads from './csv';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { TableDbProvider, useTableDb, type TableDbApi } from './store';
import { SchemaStore } from './schemaStore';
import { TableDataTab } from './TableDataTab';
import { QueryTab } from './QueryTab';
import type { Connection } from './types';

function setup(allowWrite = true) {
  const audit = { report: vi.fn() };
  const execute = vi.fn(async (p: { sql: string }) => (/^SELECT/.test(p.sql)
    ? { queryId: 'q', kind: 'read', columns: [{ name: 'id', typeName: 'int4' }, { name: 'status', typeName: 'text' }], rows: [[2, 'NEW'], [1, 'PAID']], hasMore: false, truncated: false, elapsedMs: 1 }
    : { queryId: 'q', kind: 'write', columns: [], rows: [], hasMore: false, truncated: false, elapsedMs: 1, updateCount: 1 }));
  const dbApi = {
    execute, closeCursor: vi.fn(async () => ({})), cancel: vi.fn(), fetch: vi.fn(),
    setAutoCommit: vi.fn(async (on: boolean) => ({ autoCommit: on, txPending: false })), commit: vi.fn(async () => ({ autoCommit: false, txPending: false })), rollback: vi.fn(async () => ({ autoCommit: false, txPending: false })),
    columns: vi.fn(async () => ({ columns: [{ name: 'id', typeName: 'int4', nullable: false }, { name: 'status', typeName: 'text' }], primaryKey: ['id'], foreignKeys: [] })),
    tables: vi.fn(async () => [{ name: 'orders', type: 'TABLE' }]),
  };
  const conn = {
    id: 'c1', targetId: 't1', authType: 'password', name: 'PG', driver: 'postgresql', info: { sessionId: 'c1', serverVersion: '16', user: 'u', readOnly: true },
    allowWrite, api: dbApi, store: new SchemaStore(dbApi as never), gateway: { kind: 'tauri' }, tx: { autoCommit: true, pending: false },
  } as unknown as Connection;
  let db!: TableDbApi;
  const View = () => { db = useTableDb(); const tab = db.activeTab; return tab ? (tab.kind === 'table' ? <TableDataTab tab={tab} /> : <QueryTab tab={tab} />) : null; };
  render(<ToastProvider><TableDbProvider audit={audit}><View /></TableDbProvider></ToastProvider>);
  act(() => db.addConnection(conn));
  return { get db() { return db; }, execute, dbApi };
}

describe('result grid', () => {
  it('table view: header click sorts on the server; filter-by-value adds a WHERE condition', async () => {
    const user = userEvent.setup();
    const h = setup();
    act(() => h.db.openTable({ schema: 'public', name: 'orders' }));
    await screen.findByRole('table', { name: 'Kết quả truy vấn' });
    await user.click(screen.getByRole('columnheader', { name: /status/ }));
    await waitFor(() => expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({ sql: 'SELECT * FROM public.orders\nORDER BY status' }));
    await user.click(await screen.findByRole('columnheader', { name: /status/ }));
    await waitFor(() => expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({ sql: 'SELECT * FROM public.orders\nORDER BY status DESC' }));
    fireEvent.contextMenu(await screen.findByText('PAID'));
    await user.click(screen.getByRole('menuitem', { name: /Lọc = PAID/ }));
    await waitFor(() => expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({ sql: "SELECT * FROM public.orders\nWHERE status = 'PAID'\nORDER BY status DESC" }));
  });

  it('editing a cell → review → saved as one transaction', async () => {
    const user = userEvent.setup();
    const h = setup();
    act(() => h.db.openTable({ schema: 'public', name: 'orders' }));
    await screen.findByText('Sửa được');
    await user.dblClick(await screen.findByText('NEW'));
    const input = screen.getByRole('textbox', { name: 'Sửa ô' });
    await user.clear(input);
    await user.type(input, "SHIP'D{Enter}");
    expect(screen.getByText('1 thay đổi chưa lưu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lưu…' }));
    const dlg = screen.getByRole('alertdialog');
    expect(within(dlg).getByLabelText('Câu lệnh sẽ chạy')).toHaveTextContent("UPDATE public.orders SET status = 'SHIP''D' WHERE id = 2;");
    const save = within(dlg).getByRole('button', { name: 'Lưu 1 câu lệnh' });
    expect(save).toBeDisabled();
    await user.click(within(dlg).getByLabelText(/Tôi đã kiểm tra/));
    await user.click(save);
    await waitFor(() => expect(h.dbApi.commit).toHaveBeenCalledTimes(1));
    expect(h.dbApi.setAutoCommit.mock.calls).toEqual([[false], [true]]);
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: "UPDATE public.orders SET status = 'SHIP''D' WHERE id = 2", mode: 'write', confirmWrite: true }));
    // refreshed after saving
    await waitFor(() => expect(h.execute.mock.calls.at(-1)![0]).toMatchObject({ sql: 'SELECT * FROM public.orders' }));
  });

  it('read-only connection: no editing', async () => {
    const h = setup(false);
    act(() => h.db.openTable({ schema: 'public', name: 'orders' }));
    await screen.findByRole('table', { name: 'Kết quả truy vấn' });
    expect(screen.queryByText('Sửa được')).toBeNull();
    fireEvent.doubleClick(screen.getByText('NEW'));
    expect(screen.queryByRole('textbox', { name: 'Sửa ô' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Khung xem giá trị' })).toBeInTheDocument(); // double-click opens the value viewer instead
  });

  it('SQL result: dragging a header edge resizes the column, does not sort, and survives a re-run', async () => {
    const h = setup();
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.run(id, { sql: 'SELECT id, status FROM t', from: 0 }); });
    const grid = await screen.findByRole('table', { name: 'Kết quả truy vấn' });
    const colW = () => (grid.querySelectorAll('colgroup col')[2] as HTMLElement).style.width;
    const firstCol = () => Array.from(grid.querySelectorAll('tbody tr:not(.rv-spacer)')).map((r) => r.querySelectorAll('td')[2]?.textContent);
    const w0 = parseInt(colW(), 10);
    const handle = screen.getByRole('separator', { name: 'Đổi độ rộng cột id' });
    // jsdom has no PointerEvent: MouseEvent carries clientX/button under the pointer* type names
    const ptr = (type: string, x: number) => act(() => { handle.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 })); });
    ptr('pointerdown', 100); ptr('pointermove', 150); ptr('pointermove', 180); ptr('pointerup', 180);
    expect(colW()).toBe(`${w0 + 80}px`);
    fireEvent.click(within(grid).getByRole('columnheader', { name: /^id/ })); // the click that ends a drag
    expect(firstCol()).toEqual(['2', '1']);
    await act(async () => { await h.db.run(id, { sql: 'SELECT id, status FROM t', from: 0 }); });
    expect(colW()).toBe(`${w0 + 80}px`);
  });

  it('SQL result: client sort, column filter, range selection stats, export dialog', async () => {
    const user = userEvent.setup();
    const h = setup();
    const id = h.db.activeTab!.id;
    await act(async () => { await h.db.run(id, { sql: 'SELECT id, status FROM t', from: 0 }); });
    const grid = await screen.findByRole('table', { name: 'Kết quả truy vấn' });
    const firstCol = () => Array.from(grid.querySelectorAll('tbody tr:not(.rv-spacer)')).map((r) => r.querySelectorAll('td')[2]?.textContent);
    expect(firstCol()).toEqual(['2', '1']);
    await user.click(within(grid).getByRole('columnheader', { name: /^id/ }));
    expect(firstCol()).toEqual(['1', '2']);
    expect(h.execute).toHaveBeenCalledTimes(1); // client-side
    await user.click(screen.getByRole('button', { name: 'Hàng lọc theo cột' }));
    await user.type(screen.getByLabelText('Lọc cột status'), 'pa');
    expect(firstCol()).toEqual(['1']);
    await user.clear(screen.getByLabelText('Lọc cột status'));
    // drag-select two cells → statistics in the footer
    const idCells = () => Array.from(grid.querySelectorAll('tbody tr:not(.rv-spacer)')).map((r) => r.querySelectorAll('td')[2]!);
    fireEvent.mouseDown(idCells()[0]!);
    fireEvent.mouseDown(idCells()[1]!, { shiftKey: true });
    expect(screen.getByLabelText('Thống kê vùng chọn')).toHaveTextContent('2 ô');
    expect(screen.getByLabelText('Thống kê vùng chọn')).toHaveTextContent('Σ 3');
    await user.click(screen.getByRole('button', { name: 'Xuất kết quả…' }));
    expect(screen.getByRole('dialog', { name: 'Xuất kết quả…' })).toBeInTheDocument();
    expect(screen.getByLabelText('Định dạng')).toHaveTextContent('Excel (.xlsx)');
    const report = vi.spyOn(auditReporter, 'report').mockImplementation(() => {});
    const download = vi.spyOn(downloads, 'downloadText').mockImplementation(() => {});
    try {
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Xuất' }));
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ event: 'export', targetId: 't1', format: 'csv', scope: 'view', rows: 2, ok: true, sql: 'SELECT id, status FROM t' }));
      expect(report.mock.calls[0]![0]).not.toHaveProperty('data');
      report.mockClear();
      download.mockImplementation(() => { throw new Error('disk unavailable'); });
      await user.click(screen.getByRole('button', { name: 'Xuất kết quả…' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Xuất' }));
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ event: 'export', ok: false, format: 'csv' }));
    } finally { report.mockRestore(); download.mockRestore(); }
  });
});
