import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { buildAgentContext, type ContextManifest } from '@vnpay/shared';
import { ContextDisclosure } from './ContextDisclosure';
import { SqlBlock } from './SqlBlock';
import { buildChatBody, buildPreviewBody } from './context';
import { parseReply } from './parseReply';
import { SchemaStore } from '../tabledb/schemaStore';
import type { DbApi } from '../../gateway';

const manifest = (over: Partial<ContextManifest> = {}): ContextManifest => ({
  included: [
    { schema: 'public', table: 'orders', level: 0, columns: 5, ddlIncluded: true, chars: 400 },
    { schema: 'public', table: 'customers', level: 1, columns: 3, ddlIncluded: false, chars: 150 },
  ],
  denied: [{ schema: 'secret', table: 'salaries' }],
  droppedForBudget: [{ schema: 'public', table: 'huge' }],
  suspiciousFields: 2, budgetChars: 12000, usedChars: 550, rowsIncluded: false, ...over,
});

describe('ContextDisclosure', () => {
  it('shows tables/columns/DDL, denied, dropped, suspicious and "rows: none" (before sending)', () => {
    render(<ContextDisclosure phase="before" manifest={manifest()} defaultOpen />);
    expect(screen.getByText('Ngữ cảnh sẽ gửi cho Agent')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Các bảng trong ngữ cảnh' });
    expect(within(table).getByText('public.orders')).toBeInTheDocument();
    expect(within(table).getByText('Đang chọn')).toBeInTheDocument();
    expect(within(table).getByText('Liên quan (FK)')).toBeInTheDocument();
    expect(screen.getByText('secret.salaries')).toBeInTheDocument();
    expect(screen.getByText('public.huge')).toBeInTheDocument();
    expect(screen.getByText(/2 trường nghi/)).toBeInTheDocument();
    expect(screen.getAllByText('Không').length).toBeGreaterThan(0); // rows: none badge / DDL no
    expect(screen.getByTestId('context-before').textContent).toMatch(/2 bảng, 8 cột, DDL: 1/);
  });

  it('after sending: labelled differently and shows confirmed row count when rows were attached', () => {
    render(<ContextDisclosure phase="after" manifest={manifest({ rowsIncluded: { count: 3 }, denied: [], droppedForBudget: [], suspiciousFields: 0 })} defaultOpen />);
    expect(screen.getByText('Ngữ cảnh đã gửi cho Agent')).toBeInTheDocument();
    expect(screen.getAllByText('3 dòng').length).toBeGreaterThan(0);
  });

  it('renders loading/error/empty states', () => {
    const { rerender } = render(<ContextDisclosure phase="before" manifest={null} defaultOpen />);
    expect(screen.getByText('Chưa chọn bảng.')).toBeInTheDocument();
    rerender(<ContextDisclosure phase="before" manifest={null} error="boom" defaultOpen />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});

describe('agent context body (selected tables default, related opt-in, rows never implicit)', () => {
  const columnsRes = (name: string) => ({
    columns: [{ name: 'id', typeName: 'int4', nullable: false }, { name: 'ref', typeName: 'int4' }], primaryKey: ['id'],
    foreignKeys: name === 'orders' ? [{ columns: ['ref'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] }] : [],
  });
  const mkConn = async () => {
    const api = { columns: vi.fn(async (_s: string, t: string) => columnsRes(t)), ddl: vi.fn(async () => ({ ddl: 'CREATE TABLE x()', source: 'native' })), tables: vi.fn(async () => [{ name: 'orders', type: 'TABLE' }, { name: 'customers', type: 'TABLE' }, { name: 'other', type: 'TABLE' }]) } as unknown as DbApi;
    const store = new SchemaStore(api);
    await store.loadTables(undefined, 'public');
    await store.loadColumns({ schema: 'public', name: 'orders' });
    await store.loadDdl({ schema: 'public', name: 'orders' });
    return { id: 'c1', name: 'PG test', driver: 'postgresql' as const, store };
  };

  it('accessible contains only tables whose metadata was loaded; no rows unless provided', async () => {
    const conn = await mkConn();
    const body = buildPreviewBody(conn, [{ schema: 'public', name: 'orders' }], false);
    expect(body.selectedTables).toEqual([{ schema: 'public', name: 'orders' }]);
    expect(body.accessible.map((a) => a.name)).toEqual(['orders']); // 'other'/'customers' listed in tree but not loaded => not accessible
    expect(body.expandRelated).toBe(false);
    expect(body.rows).toBeUndefined();
    expect(body.accessible[0]?.ddl).toBe('CREATE TABLE x()');
  });

  it('related tables are only in context when opted-in AND loaded; shared buildAgentContext honours it', async () => {
    const conn = await mkConn();
    await conn.store.loadColumns({ schema: 'public', name: 'customers' });
    const off = buildPreviewBody(conn, [{ schema: 'public', name: 'orders' }], false);
    const on = buildPreviewBody(conn, [{ schema: 'public', name: 'orders' }], true);
    const ctx = (b: typeof off) => buildAgentContext({ dialect: b.dialect, connectionName: b.connectionName, selectedTables: b.selectedTables, accessible: b.accessible.map((a) => ({ ...a, columns: a.columns })), expandRelated: b.expandRelated, nonce: 'n' });
    expect(ctx(off).manifest.included.map((i) => i.table)).toEqual(['orders']);
    expect(ctx(on).manifest.included.map((i) => `${i.table}:${i.level}`)).toEqual(['orders:0', 'customers:1']);
  });

  it('rows are attached only when explicitly passed (confirmed:true) and capped at 20', async () => {
    const conn = await mkConn();
    const rows = { columns: ['a'], rows: Array.from({ length: 30 }, (_, i) => [i]) };
    const body = buildChatBody(conn, [], false, [{ role: 'user', content: 'hi' }], rows);
    expect(body.rows?.confirmed).toBe(true);
    expect(body.rows?.rows).toHaveLength(20);
    expect(buildChatBody(conn, [], false, [{ role: 'user', content: 'hi' }], null).rows).toBeUndefined();
  });
});

describe('SqlBlock / parseReply', () => {
  const wrap = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

  it('shows the classification badge and inserts (never runs) on click', async () => {
    const onInsert = vi.fn();
    wrap(<SqlBlock sql="SELECT 1" onInsert={onInsert} />);
    expect(screen.getByText('ĐỌC')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /chạy/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Chèn vào editor' }));
    expect(onInsert).toHaveBeenCalledWith('SELECT 1');
  });

  it('labels write / ddl and multi-statement, and takes the most severe of client and server classification', () => {
    const { unmount } = wrap(<SqlBlock sql="DELETE FROM t" onInsert={() => {}} />);
    expect(screen.getByText('GHI')).toBeInTheDocument();
    expect(screen.getByText(/Không phải câu lệnh đọc/)).toBeInTheDocument();
    unmount();
    wrap(<SqlBlock sql="SELECT 1" serverKind="ddl" onInsert={() => {}} />);
    expect(screen.getByText('DDL')).toBeInTheDocument();
  });

  it('flags multi-statement SQL', () => {
    wrap(<SqlBlock sql="SELECT 1; DROP TABLE t" onInsert={() => {}} />);
    expect(screen.getByText('Nhiều câu lệnh')).toBeInTheDocument();
    expect(screen.getByText('KHÁC')).toBeInTheDocument();
  });

  it('parseReply splits fenced blocks and ignores unclosed fences', () => {
    const segs = parseReply('Here:\n```sql\nSELECT 1\n```\nDone ```not closed');
    expect(segs.map((s) => s.type)).toEqual(['text', 'code', 'text']);
    expect(segs[1]).toMatchObject({ lang: 'sql', code: 'SELECT 1' });
  });
});
