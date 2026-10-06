import { TEST_DB_CONFIG } from '../../test/dbConfig';
import { DEFAULT_RUNTIME } from '../agent/runtimeConfig';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { apiClient } from '../../api/client';
import { AuthContext, type AuthState } from '../../auth/AuthContext';
import TableDbPage from './TableDbPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const auth: AuthState = {
  status: 'authenticated', can: (p) => ['db:connect', 'db:custom', 'agent:use'].includes(p), refresh: async () => {}, logout: async () => {},
  me: { user: { id: 'u', email: 'e@x', name: 'E', roles: ['user'], permissions: ['db:connect', 'db:custom', 'agent:use'] }, csrfToken: 'csrf', authTime: 0, kind: 'web' },
};

type Call = { url: string; method: string; body?: unknown };
let calls: Call[];        // HTTP calls to services/api
let sidecar: Array<{ method: string; params: Record<string, unknown> }>;   // sidecar_request calls (local TauriGateway)
beforeEach(() => {
  calls = []; sidecar = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      // the Agent is local: settings come from the server through Rust, the token metadata from the credential store
      if (cmd === 'agent_config') return { status: 200, body: JSON.stringify({ runtime: DEFAULT_RUNTIME, endpoints: [{ id: 'e1', label: 'LLM', baseUrl: 'https://llm.example.vn/v1', models: ['m1'] }], defaultEndpointId: 'e1', defaultModel: 'm1', budgetChars: 12000, openMetadataEnabled: false }) };
      if (cmd === 'secret_get') return (args as { key: string }).key === 'agent:meta:llm' ? JSON.stringify({ endpointId: 'e1', model: 'm1', lastVerifiedAt: '2026-01-01T00:00:00Z' }) : null;
      if (cmd !== 'sidecar_request') return null;
      const { method, params } = args as { method: string; params: Record<string, unknown> };
      sidecar.push({ method, params });
      if (method === 'session.open') return { sessionId: 's1', serverVersion: 'PG 16', user: 'alice', readOnly: true };
      if (method === 'session.close') return {};
      if (method === 'meta.catalogs') return { catalogs: [] };
      if (method === 'meta.schemas') return { schemas: ['public'] };
      if (method === 'meta.tables') return { tables: [{ name: 'orders', type: 'TABLE' }] };
      if (method === 'meta.columns') return { columns: [{ name: 'id', typeName: 'int4', nullable: false }], primaryKey: ['id'], foreignKeys: [] };
      // table data view (no LIMIT): first page + an open cursor, the next page comes from query.fetch
      if (method === 'query.execute' && /^SELECT \* FROM public\.orders$/.test(String(params.sql))) return { queryId: 'q', kind: 'read', columns: [{ name: 'id', typeName: 'int4' }], rows: [[1], [2]], hasMore: true, cursorId: 'c1', truncated: false, elapsedMs: 3 };
      if (method === 'query.fetch') return { rows: [[3], [4]], hasMore: false, truncated: false };
      if (method === 'query.closeCursor') return {};
      if (method === 'query.execute') return { queryId: 'q', kind: 'read', columns: [{ name: 'id', typeName: 'int4' }], rows: [[1], [2]], hasMore: false, truncated: false, elapsedMs: 3 };
      throw { code: 'E_BAD_REQUEST', message: 'unmocked ' + method };
    },
  };
  apiClient.configure({ desktop: false, baseUrl: '/api/v1', onStepUp: undefined, fetchImpl: (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/db/config')) return json(TEST_DB_CONFIG);
    if (url.endsWith('/db/targets')) return json([{ id: 't1', name: 'PG UAT', driver: 'postgresql', host: 'h', port: 5432, database: 'app', allowWrite: false, authModes: ['password'] }]);
    if (url.endsWith('/db/audit')) return json({ ok: true }, 201);
    return json({ error: { code: 'NOT_FOUND', message: 'unmocked ' + url } }, 404);
  }) as unknown as typeof fetch });
  apiClient.setCsrfToken('csrf');
});
afterEach(() => { vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

describe('TableDB page smoke (jsdom)', () => {
  it('connect -> lazy schema tree -> select table -> run query -> result grid', async () => {
    const user = userEvent.setup();
    render(<AuthContext.Provider value={auth}><ToastProvider><MemoryRouter><TableDbPage /></MemoryRouter></ToastProvider></AuthContext.Provider>);
    await user.selectOptions(await screen.findByLabelText('Loại cơ sở dữ liệu / driver'), 'postgresql');
    await user.type(screen.getByLabelText('Máy chủ (IP hoặc hostname)'), 'h');
    await user.type(screen.getByLabelText('Database'), 'app');
    await user.type(screen.getByLabelText('Tên đăng nhập'), 'alice');
    await user.type(screen.getByLabelText('Mật khẩu'), 'pw');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    const open = await waitFor(() => { const c = sidecar.find((x) => x.method === 'session.open'); expect(c).toBeTruthy(); return c!; });
    expect(open.params).toMatchObject({ profile: { driver: 'postgresql', host: 'h', port: 5432, database: 'app', auth: { type: 'password', username: 'alice', password: 'pw' } } });
    expect(calls.some((c) => c.url.endsWith('/db/sessions') || c.url.endsWith('/db/profiles'))).toBe(false);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/db/audit'))?.body).toMatchObject({ custom: { driver: 'postgresql', host: 'h', port: 5432, database: 'app' }, event: 'open', authType: 'password' }));

    // tree is lazy: schemas load after catalogs (empty => schemas at root); tables only after expanding
    const schema = await screen.findByRole('treeitem', { name: /public/ });
    expect(sidecar.some((c) => c.method === 'meta.tables')).toBe(false);
    await user.click(within(schema).getByText('▸'));
    const table = await screen.findByRole('treeitem', { name: /orders/ });
    await user.click(within(table).getByText('orders'));
    await waitFor(() => expect(sidecar.some((c) => c.method === 'meta.columns')).toBe(true));

    // a plain click opens the table's data tab (DBeaver-style): whole table, paged from a server cursor
    const dataExec = await waitFor(() => { const c = sidecar.find((x) => x.method === 'query.execute'); expect(c).toBeTruthy(); return c!; });
    expect(dataExec.params).toMatchObject({ sql: 'SELECT * FROM public.orders', mode: 'read', maxRows: 100000, pageSize: 200 });
    expect(await screen.findByRole('table', { name: 'Kết quả truy vấn' })).toBeInTheDocument();
    expect(screen.getByText('Đã tải 2 dòng · cuộn xuống để tải thêm')).toBeInTheDocument();
    // scrolling to the end fetches the next page
    fireEvent.scroll(screen.getByTestId('result-scroll'));
    await waitFor(() => expect(screen.getByText('Đã tải hết 4 dòng')).toBeInTheDocument());
    expect(sidecar.filter((c) => c.method === 'query.fetch')).toEqual([{ method: 'query.fetch', params: { cursorId: 'c1', count: 200 } }]);
    // JSON / Text views of the same rows
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByRole('region', { name: 'JSON' }).textContent).toContain('"id": 4');
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByRole('region', { name: 'Text' }).textContent).toMatch(/id\n-+\n\s*1\n/);
    // clicking the table again focuses the same tab (no second query)
    await user.click(within(table).getByText('orders'));
    expect(sidecar.filter((c) => c.method === 'query.execute')).toHaveLength(1);
    // WHERE filter re-queries the table
    await user.type(screen.getByLabelText('Điều kiện lọc (WHERE)'), 'id > 2{Enter}');
    await waitFor(() => expect(sidecar.filter((c) => c.method === 'query.execute').at(-1)!.params.sql).toBe('SELECT * FROM public.orders\nWHERE id > 2'));
    // agent is a popup opened from the toolbar; its context "before" preview is requested only for selected tables
    expect(screen.queryByRole('dialog', { name: 'Agent' })).toBeNull(); // closed by default
    await user.click(screen.getByRole('button', { name: '✦ Agent' }));
    expect(screen.getByRole('dialog', { name: 'Agent' })).toBeVisible();
    expect(screen.getByLabelText('Model trả lời')).toHaveValue('e1|m1');
    await waitFor(() => expect(screen.getByTestId('context-before').textContent).toMatch(/1 bảng, 1 cột/));
    // the Agent is local: nothing under /agent/* is requested from the API server
    expect(calls.filter((c) => c.url.includes('/agent/'))).toEqual([]);
    // collapse back to the floating bubble (focus returns to it), then expand again
    await user.click(screen.getByRole('button', { name: 'Thu nhỏ Agent (Esc)' }));
    expect(screen.queryByRole('dialog', { name: 'Agent' })).toBeNull();
    expect(screen.getByRole('button', { name: '✦ Agent' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '✦ Agent' }));
    expect(screen.getByRole('dialog', { name: 'Agent' })).toBeVisible();

    // double-click inserts SELECT into the SQL editor tab (switching away from the data tab)
    await user.dblClick(within(table).getByText('orders'));
    await waitFor(() => expect(screen.getByLabelText('Trình soạn SQL').textContent).toContain('SELECT * FROM public.orders'));
    // editor exists (CodeMirror) and write mode is disabled
    expect(screen.getByRole('button', { name: /^Chế độ: Đọc/ })).toBeDisabled();
    const before = sidecar.filter((x) => x.method === 'query.execute').length;
    await user.click(within(screen.getByRole('toolbar', { name: 'Công cụ SQL' })).getByRole('button', { name: 'Chạy' }));
    const exec = await waitFor(() => { const c = sidecar.filter((x) => x.method === 'query.execute')[before]; expect(c).toBeTruthy(); return c!; });
    expect(exec.params).toMatchObject({ mode: 'read', maxRows: 1000, timeoutSec: 60 });
    expect(await screen.findByRole('table', { name: 'Kết quả truy vấn' })).toBeInTheDocument();
    // the run is reported to the audit endpoint: raw SQL + counts, never row data
    const audit = await waitFor(() => { const c = calls.filter((x) => x.url.endsWith('/db/audit') && /LIMIT/.test(String((x.body as { sql?: string })?.sql))).at(-1); expect(c).toBeTruthy(); return c!.body as Record<string, unknown>; });
    expect(audit).toMatchObject({ custom: { host: 'h' }, mode: 'read', kind: 'read', ok: true, rows: 2 });
    expect(String(audit.sql)).toContain('SELECT * FROM public.orders');
    expect(JSON.stringify(audit)).not.toMatch(/\[\[1\]/);
  });
});
