import { render, screen } from '@testing-library/react';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { Permission } from '@vnpay/shared';
import { AuthContext, type AuthState } from './auth/AuthContext';
import { DesktopRoutes } from './desktop/routes';
import { WebRoutes } from './web/routes';

// Stub the lazy pages: these tests are about which routes exist per target, not about page behaviour.
vi.mock('./features/tabledb/TableDbPage', () => ({ default: () => <div>PAGE:tabledb</div> }));
vi.mock('./features/transfers/DesktopMyTransfersPage', () => ({ default: () => <div>PAGE:desktop-my-transfers</div> }));
vi.mock('./features/transfers/NewTransferPage', () => ({ default: () => <div>PAGE:new-transfer</div> }));
vi.mock('./features/transfers/DesktopTicketDetailPage', () => ({ default: () => <div>PAGE:desktop-ticket</div> }));
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

describe('web target router (BO portal: approvals + download + office → jump upload)', () => {
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

describe('desktop target router (TableDB + Agent + upload)', () => {
  it.each([['/tabledb', 'PAGE:tabledb'], ['/transfers', 'PAGE:desktop-my-transfers'], ['/transfers/new', 'PAGE:new-transfer'], ['/transfers/T1', 'PAGE:desktop-ticket']])('serves %s', async (p, marker) => {
    at(DesktopRoutes, p);
    expect(await screen.findByText(marker)).toBeInTheDocument();
  });
  it.each(['/approvals', '/download', '/transfers/T1/download', '/admin', '/audit'])('has no %s route (approvals / download / admin)', async (p) => {
    at(DesktopRoutes, p);
    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument();
    expect(screen.queryByText(/^PAGE:/)).toBeNull();
  });
  it('index goes to TableDB; navigation has no approvals/admin entries', async () => {
    at(DesktopRoutes, '/');
    expect(await screen.findByText('PAGE:tabledb')).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    expect(nav).toHaveTextContent('TableDB');
    for (const l of ['Phê duyệt', 'Quản trị', 'Nhật ký audit']) expect(nav).not.toHaveTextContent(l);
  });
  it('TableDB needs db:connect', async () => {
    at(DesktopRoutes, '/tabledb', ['transfer:create']);
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
function runtimeImports(source: string, target?: 'web' | 'desktop'): string[] {
  const file = ts.createSourceFile('module.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports: string[] = [];
  const targetCondition = (node: ts.Expression): boolean | undefined => {
    if (!target || !ts.isBinaryExpression(node)) return undefined;
    const op = node.operatorToken.kind;
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return undefined;
    const left = node.left.getText(file).replace(/\s/g, '');
    const right = node.right.getText(file).replace(/\s/g, '');
    const literal = left === 'import.meta.env.VITE_TARGET' && ts.isStringLiteral(node.right) ? node.right.text
      : right === 'import.meta.env.VITE_TARGET' && ts.isStringLiteral(node.left) ? node.left.text : undefined;
    return literal === undefined ? undefined : op === ts.SyntaxKind.EqualsEqualsEqualsToken ? target === literal : target !== literal;
  };
  const visit = (node: ts.Node) => {
    if (ts.isConditionalExpression(node) || ts.isIfStatement(node)) {
      const known = targetCondition(ts.isConditionalExpression(node) ? node.condition : node.expression);
      if (known !== undefined) {
        const branch = ts.isConditionalExpression(node) ? known ? node.whenTrue : node.whenFalse : known ? node.thenStatement : node.elseStatement;
        if (branch) visit(branch);
        return;
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const namedTypesOnly = bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !(namedTypesOnly && !clause?.name)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const namedTypesOnly = clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
      if (!node.isTypeOnly && !namedTypesOnly) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      imports.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}
function reach(entry: string): string[] {
  const seen = new Set<string>(); const stack = [join(SRC, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    // auth/desktopLogin is only reachable through `if (import.meta.env.VITE_TARGET === 'desktop')` branches (folded at build; see bundle greps in README)
    if (f.endsWith('auth/desktopLogin.ts')) continue;
    const src = readFileSync(f, 'utf8');
    for (const spec of runtimeImports(src, entry.startsWith('desktop/') ? 'desktop' : 'web')) { const r = resolve(f, spec); if (r && !r.includes('.test.')) stack.push(r); }
  }
  return [...seen].map((f) => f.slice(SRC.length + 1));
}
const has = (files: string[], ...frags: string[]) => files.filter((f) => frags.some((x) => f.includes(x)));

describe('bundle boundaries (import graph)', () => {
  it('traverses runtime imports and reexports while excluding erased type dependencies', () => {
    expect(runtimeImports(`
      import type { Mapping } from './types';
      import { type State } from './state';
      export type { Config } from './config';
      export { type Row } from './rows';
      import './side-effect';
      import Default, { type Metadata } from './default';
      import { value, type Shape } from './mixed';
      import * as namespace from './namespace';
      export * from './exports';
      export { value as alias, type Kind } from './mixed-exports';
      const lazy = () => import('./lazy');
      // import('./comment-only')
      const text = "from './string-only'";
    `)).toEqual(['./side-effect', './default', './mixed', './namespace', './exports', './mixed-exports', './lazy']);
  });
  it('folds explicit Vite target branches without excluding unconditional runtime imports', () => {
    const source = `
      import './always';
      const panel = import.meta.env.VITE_TARGET === 'desktop' ? import('./desktop-panel') : import('./web-panel');
      if (import.meta.env.VITE_TARGET === 'desktop') { import('./desktop-login'); }
      else { import('./web-login'); }
    `;
    expect(runtimeImports(source, 'web')).toEqual(['./always', './web-panel', './web-login']);
    expect(runtimeImports(source, 'desktop')).toEqual(['./always', './desktop-panel', './desktop-login']);
  });
  it('web boot never reaches TableDB, gateway, Agent, Tauri bridge or desktop pages (the upload pipeline is shared)', () => {
    const g = reach('web/boot.ts');
    expect(has(g, 'features/tabledb', 'features/agent', 'gateway/', 'runtime/tauri', 'runtime/secretTokenStore', 'desktop/', 'Desktop', 'desktopSave')).toEqual([]);
    expect(has(g, 'NewTransferPage', 'uploadFlow', 'services.upload')).toHaveLength(3);
  });
  it('desktop boot never reaches admin, approvals, download or delegations', () => {
    const g = reach('desktop/boot.ts');
    expect(has(g, 'features/admin', 'ApprovalsPage', 'DecisionPanel', 'transfers/download', 'services.web', 'web/', 'transfers/TicketDetailPage', 'transfers/MyTransfersPage')).toEqual([]);
  });
});
