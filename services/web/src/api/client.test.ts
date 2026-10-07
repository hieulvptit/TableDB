import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';
import { ApiError } from './errors';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
type F = ReturnType<typeof vi.fn>;
const hdr = (f: F, i: number) => ((f.mock.calls[i]![1] as RequestInit).headers as Record<string, string>);

describe('ApiClient (web: cookie + CSRF)', () => {
  it('fetches the CSRF token from /auth/me once and sends it on non-GET only; uses credentials=include', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ csrfToken: 'tok1' }))        // /auth/me
      .mockResolvedValueOnce(json({ ok: 1 }))                     // POST
      .mockResolvedValueOnce(json({ ok: 2 }));                    // GET
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch });
    await c.post('/x', { a: 1 });
    await c.get('/y');
    expect(f.mock.calls[0]![0]).toBe('/c/api/v1/auth/me');
    expect(hdr(f, 1)['X-CSRF-Token']).toBe('tok1');
    expect(hdr(f, 1)['Authorization']).toBeUndefined();
    expect(hdr(f, 2)['X-CSRF-Token']).toBeUndefined();
    expect((f.mock.calls[1]![1] as RequestInit).credentials).toBe('include');
  });

  it('uses an already-known csrf token without extra calls', async () => {
    const f = vi.fn().mockResolvedValue(json({}));
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch });
    c.setCsrfToken('known');
    await c.del('/z');
    expect(f).toHaveBeenCalledTimes(1);
    expect(hdr(f, 0)['X-CSRF-Token']).toBe('known');
  });

  it('maps the error envelope to ApiError (code, status, details)', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: { code: 'CONFLICT', message: 'dup', details: { part: 3 } } }, 409));
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch });
    await expect(c.get('/a')).rejects.toMatchObject({ code: 'CONFLICT', status: 409, message: 'dup', details: { part: 3 } });
  });

  it('maps network failures and non-envelope bodies', async () => {
    const c1 = new ApiClient({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(c1.get('/a')).rejects.toMatchObject({ code: 'NETWORK' });
    const c2 = new ApiClient({ fetchImpl: (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch });
    await expect(c2.get('/a')).rejects.toMatchObject({ code: 'UPSTREAM', status: 502 });
  });

  it('STEPUP_REQUIRED on web: calls onStepUp (redirect) and surfaces the error without retrying', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: { code: 'STEPUP_REQUIRED', message: 'reauth' } }, 401, { 'X-Stepup': 'required' }));
    const onStepUp = vi.fn(async () => 'redirected' as const);
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch, onStepUp });
    c.setCsrfToken('c');
    const err = (await c.post('/transfers/1/download-token').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isStepUp).toBe(true);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('detects step-up from the X-Stepup header even without a code', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401, headers: { 'X-Stepup': 'required' } }));
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch });
    c.setCsrfToken('c');
    await expect(c.post('/x')).rejects.toMatchObject({ code: 'STEPUP_REQUIRED' });
  });

  it('refetches CSRF once when the server says the token is stale', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN', message: 'bad csrf token' } }, 403))
      .mockResolvedValueOnce(json({ csrfToken: 'fresh' }))
      .mockResolvedValueOnce(json({ ok: true }));
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch });
    c.setCsrfToken('stale');
    await expect(c.post('/x')).resolves.toEqual({ ok: true });
    expect(hdr(f, 2)['X-CSRF-Token']).toBe('fresh');
  });

  it('notifies onUnauthenticated on 401 UNAUTHENTICATED', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401));
    const onUnauthenticated = vi.fn();
    const c = new ApiClient({ fetchImpl: f as unknown as typeof fetch, onUnauthenticated });
    await expect(c.get('/auth/me')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalled();
  });
});
