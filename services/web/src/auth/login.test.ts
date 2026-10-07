import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { installStepUpHandler, safeReturnTo, webLoginUrl } from './login';

afterEach(() => { localStorage.clear(); });

describe('safeReturnTo', () => {
  it('allows only same-origin paths', () => {
    expect(safeReturnTo('/tabledb?x=1')).toBe('/tabledb?x=1');
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil', '', null, undefined]) expect(safeReturnTo(bad as string)).toBe('/');
  });
});

describe('step-up handler', () => {
  it('uses powerbi for step-up even when a different provider was remembered', async () => {
    localStorage.setItem('tabledb.lastProvider', 'vnpaybi');
    const nav = vi.fn();
    const c = new ApiClient({ baseUrl: '/api/v1' });
    installStepUpHandler(c, nav);
    expect(await c.onStepUp!()).toBe('redirected');
    const url = new URL(nav.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/api/v1/auth/login');
    expect(url.searchParams.get('provider')).toBe('powerbi');
    expect(url.searchParams.get('stepup')).toBe('1');
    expect(url.searchParams.get('returnTo')?.startsWith('/')).toBe(true);
  });
  it('without a remembered provider still uses powerbi', async () => {
    const nav = vi.fn();
    const c = new ApiClient({});
    installStepUpHandler(c, nav);
    await c.onStepUp!();
    const url = new URL(nav.mock.calls[0]![0] as string, 'http://x');
    expect(url.searchParams.get('provider')).toBe('powerbi');
    expect(url.searchParams.get('stepup')).toBe('1');
  });
  it('webLoginUrl carries stepup only when asked', () => {
    const c = new ApiClient({ baseUrl: '/api/v1' });
    expect(webLoginUrl(c, '/x')).not.toContain('stepup');
    expect(webLoginUrl(c, '/x', true)).toContain('stepup=1');
  });
  it('keeps authentication return paths under the app base without duplicating it', () => {
    const c = new ApiClient({ baseUrl: '/api/v1' });
    for (const [path, expected] of [['/', '/c/'], ['/transfers?x=1', '/c/transfers?x=1'], ['/c/transfers?x=1', '/c/transfers?x=1']]) {
      const url = new URL(webLoginUrl(c, path!), 'http://x');
      expect(url.searchParams.get('returnTo')).toBe(expected);
    }
  });
});
