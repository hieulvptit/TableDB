import { render, screen } from '@testing-library/react';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Permission } from '@vnpay/shared';
import { AuthContext, type AuthState } from './auth/AuthContext';
import { WebRoutes } from './web/routes';

// Stub the lazy pages: these tests are about which routes exist, not about page behaviour.
vi.mock('./features/transfers/NewTransferPage', () => ({ default: () => <div>PAGE:new-transfer</div> }));
vi.mock('./features/transfers/MyTransfersPage', () => ({ default: () => <div>PAGE:web-my-transfers</div> }));
vi.mock('./features/transfers/TicketDetailPage', () => ({ default: () => <div>PAGE:web-ticket</div> }));
vi.mock('./features/transfers/ApprovalsPage', () => ({ default: () => <div>PAGE:approvals</div> }));
vi.mock('./features/admin/AdminPage', () => ({ AuditPage: () => <div>PAGE:audit</div> }));

const ALL: Permission[] = ['db:connect', 'db:write', 'agent:use', 'transfer:create', 'transfer:download', 'transfer:approve', 'admin:manage', 'audit:read'];
const auth = (perms: Permission[] = ALL): AuthState => ({
  status: 'authenticated', can: (p) => perms.includes(p), refresh: async () => {}, logout: async () => {},
  me: { user: { id: 'u1', email: 'a@b.c', name: 'A', roles: ['user'], permissions: perms }, csrfToken: 'x', authTime: 0, kind: 'web' },
});
const at = (Routes: () => JSX.Element, path: string, perms?: Permission[]) => render(
  <AuthContext.Provider value={auth(perms)}><MemoryRouter initialEntries={[path]}><Routes /></MemoryRouter></AuthContext.Provider>,
);
const NOT_FOUND = 'Không tìm thấy trang';

describe('web BO router (BO portal: approvals + download + office → jump upload)', () => {
  it.each(['/transfers', '/transfers/new', '/transfers/T1', '/approvals', '/audit'])('serves %s', async (p) => {
    at(WebRoutes, p);
    expect(await screen.findByText(/^PAGE:/)).toBeInTheDocument();
  });
  it('/transfers/new is the upload wizard, not a ticket id', async () => {
    at(WebRoutes, '/transfers/new');
    expect(await screen.findByText('PAGE:new-transfer')).toBeInTheDocument();
  });
  it.each(['/tabledb', '/tableDB', '/tabledb/x'])('has no %s route (TableDB)', async (p) => {
    at(WebRoutes, p);
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument();
    expect(screen.queryByText(/^PAGE:/)).toBeNull();
  });
  it('navigation shows BO entries only', async () => {
    at(WebRoutes, '/approvals');
    await screen.findByText('PAGE:approvals');
    const nav = screen.getByRole('navigation');
    for (const l of ['Chuyển file', 'Phê duyệt', 'Nhật ký audit']) expect(nav).toHaveTextContent(l);
    for (const l of ['TableDB', 'Gửi file mới', 'Quản trị']) expect(nav).not.toHaveTextContent(l);
  });
  it('there is no /admin route any more (even with admin:manage)', async () => {
    at(WebRoutes, '/admin');
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument();
  });
  it('the guard still applies (approver without audit:read cannot open /audit)', async () => {
    at(WebRoutes, '/audit', ['transfer:approve']);
    expect(await screen.findByText('Không có quyền truy cập')).toBeInTheDocument();
  });
});

// ---- static import-graph guard: what each target's route module can reach (lazy imports included) ----
const SRC = __dirname;
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (/\.tsx?$/.test(c) && existsSync(c)) return c;
  return null;
}
function reach(entry: string): string[] {
  const seen = new Set<string>(); const stack = [join(SRC, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) { const r = resolve(f, m[1]!); if (r && !r.includes('.test.')) stack.push(r); }
  }
  return [...seen].map((f) => f.slice(SRC.length + 1));
}
const has = (files: string[], ...frags: string[]) => files.filter((f) => frags.some((x) => f.includes(x)));

describe('bundle boundaries (import graph)', () => {
  it('the app entry never reaches TableDB, gateway, Agent, Tauri bridge or desktop pages (the upload pipeline is included)', () => {
    const g = reach('main.tsx');
    expect(has(g, 'features/tabledb', 'features/agent', 'gateway/', 'runtime/', 'desktop/', 'Desktop', 'desktopSave', 'desktopLogin')).toEqual([]);
    expect(has(g, 'NewTransferPage', 'uploadFlow', 'services.upload')).toHaveLength(3);
  });
});
