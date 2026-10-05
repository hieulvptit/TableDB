import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { installStepUpHandler, rememberProvider, safeReturnTo, webLoginUrl } from './login';

afterEach(() => { localStorage.clear(); });

describe('safeReturnTo', () => {
  it('allows only same-origin paths', () => {
    expect(safeReturnTo('/tabledb?x=1')).toBe('/tabledb?x=1');
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil', '', null, undefined]) expect(safeReturnTo(bad as string)).toBe('/');
  });
});

describe('step-up handler', () => {
  it('navigates to /auth/login?...&stepup=1 for the remembered provider and reports "redirected"', async () => {
    rememberProvider('s2o');
    const nav = vi.fn();
    const c = new ApiClient({ baseUrl: '/api/v1' });
    installStepUpHandler(c, nav);
    expect(await c.onStepUp!()).toBe('redirected');
    const url = new URL(nav.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/api/v1/auth/login');
    expect(url.searchParams.get('provider')).toBe('s2o');
    expect(url.searchParams.get('stepup')).toBe('1');
    expect(url.searchParams.get('returnTo')?.startsWith('/')).toBe(true);
  });
  it('without a remembered provider falls back to the SPA login page', async () => {
    const nav = vi.fn();
    const c = new ApiClient({});
    installStepUpHandler(c, nav);
    await c.onStepUp!();
    expect(nav.mock.calls[0]![0]).toMatch(/^\/login\?stepup=1&returnTo=/);
  });
  it('webLoginUrl carries stepup only when asked', () => {
    const c = new ApiClient({ baseUrl: '/api/v1' });
    expect(webLoginUrl(c, 'g', '/x')).not.toContain('stepup');
    expect(webLoginUrl(c, 'g', '/x', true)).toContain('stepup=1');
  });
});
