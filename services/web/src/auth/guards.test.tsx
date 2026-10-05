import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Permission } from '@vnpay/shared';
import { AuthContext, RequireAuth, type AuthState } from './AuthContext';

const auth = (status: AuthState['status'], perms: Permission[] = []): AuthState => ({
  status, me: status === 'authenticated' ? { user: { id: 'u1', email: 'a@b.c', name: 'A', roles: ['user'], permissions: perms }, csrfToken: 'x', authTime: 0, kind: 'web' } : null,
  can: (p) => perms.includes(p), refresh: async () => {}, logout: async () => {},
});
const Where = () => { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; };

const renderAt = (a: AuthState, path: string, permission?: Permission | Permission[]) => render(
  <AuthContext.Provider value={a}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<Where />} />
        <Route path="/admin" element={<RequireAuth permission={permission}><div>SECRET ADMIN</div></RequireAuth>} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('RequireAuth route guard', () => {
  it('redirects anonymous users to /login with returnTo', () => {
    renderAt(auth('anonymous'), '/admin?x=1', 'admin:manage');
    expect(screen.getByTestId('where')).toHaveTextContent('/login?returnTo=%2Fadmin%3Fx%3D1');
    expect(screen.queryByText('SECRET ADMIN')).toBeNull();
  });
  it('shows a spinner while the session is loading (no flash of content or redirect)', () => {
    renderAt(auth('loading'), '/admin', 'admin:manage');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('SECRET ADMIN')).toBeNull();
  });
  it('renders the 403 view when the permission is missing', () => {
    renderAt(auth('authenticated', ['db:connect']), '/admin', 'admin:manage');
    expect(screen.getByText('Không có quyền truy cập')).toBeInTheDocument();
    expect(screen.queryByText('SECRET ADMIN')).toBeNull();
  });
  it('renders children when the permission is present (or any of a list)', () => {
    renderAt(auth('authenticated', ['admin:manage']), '/admin', 'admin:manage');
    expect(screen.getByText('SECRET ADMIN')).toBeInTheDocument();
  });
  it('accepts any-of permission lists', () => {
    renderAt(auth('authenticated', ['transfer:download']), '/admin', ['transfer:create', 'transfer:download']);
    expect(screen.getByText('SECRET ADMIN')).toBeInTheDocument();
  });
  it('no permission requirement => any authenticated user', () => {
    renderAt(auth('authenticated'), '/admin');
    expect(screen.getByText('SECRET ADMIN')).toBeInTheDocument();
  });
});
