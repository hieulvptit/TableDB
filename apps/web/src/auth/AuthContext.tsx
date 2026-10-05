import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@vnpay/shared';
import { Spinner } from '@vnpay/ui';
import { apiClient } from '../api/client';
import type { Me } from '../api/types';
import { t } from '../i18n';
import { ForbiddenPage } from '../components/ForbiddenPage';

export interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  me: Me | null;
  can: (p: Permission) => boolean;
  /** `strict`: rethrow the /auth/me failure instead of silently falling back to anonymous (used right after a login). */
  refresh: (o?: { strict?: boolean }) => Promise<void>;
  /** `forgetSso` (desktop, broker login): also delete the login window's SSO cookie profile after the API session is revoked. */
  logout: (o?: { forgetSso?: boolean }) => Promise<void>;
}
export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const c = useContext(AuthContext);
  if (!c) throw new Error('AuthContext missing');
  return c;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');

  const refresh = useCallback(async (o?: { strict?: boolean }) => {
    try {
      if (apiClient.isDesktop && !(await apiClient.tokenStore.load())) { setMe(null); setStatus('anonymous'); return; }
      const m = await apiClient.get<Me>('/auth/me');
      apiClient.setCsrfToken(m.csrfToken);
      setMe(m);
      setStatus('authenticated');
    } catch (e) {
      setMe(null);
      setStatus('anonymous');
      if (o?.strict) throw e;
    }
  }, []);

  useEffect(() => {
    apiClient.onUnauthenticated = () => { setMe(null); setStatus('anonymous'); };
    void refresh();
  }, [refresh]);

  const logout = useCallback(async (o?: { forgetSso?: boolean }) => {
    try { await apiClient.post('/auth/logout'); } catch { /* best effort */ }
    if (apiClient.isDesktop) await apiClient.tokenStore.clear();
    // Build-time constant: the desktop-only module is not part of the web bundle.
    if (o?.forgetSso && import.meta.env.VITE_TARGET === 'desktop') {
      try { await (await import('./desktopLogin')).forgetGenaiSso(); } catch { /* best effort */ }
    }
    apiClient.setCsrfToken(null);
    setMe(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthState>(() => {
    const perms = new Set<Permission>(me?.user.permissions ?? []);
    return { status, me, can: (p) => perms.has(p), refresh, logout };
  }, [me, status, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Route guard: requires a session, optionally a permission. The server still enforces; this only avoids dead-end UI. */
export function RequireAuth({ children, permission }: { children: ReactNode; permission?: Permission | Permission[] }) {
  const { status, can } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <div style={{ display: 'grid', placeItems: 'center', height: '60vh' }}><Spinner size="lg" label={t('common.loading')} /></div>;
  if (status === 'anonymous') return <Navigate to={`/login?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (permission) {
    const need = Array.isArray(permission) ? permission : [permission];
    if (!need.some((p) => can(p))) return <ForbiddenPage />;
  }
  return <>{children}</>;
}
