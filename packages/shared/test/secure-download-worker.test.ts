import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSecureDownloadWorker } from '../src/secure-download-worker.js';

afterEach(() => vi.unstubAllGlobals());

describe('secure download API paths', () => {
  const origin = 'http://localhost:8080';
  function register(baseUrl: string, path: string) {
    vi.stubGlobal('crypto', webcrypto);
    const handlers: Record<string, (event: any) => void> = {};
    installSecureDownloadWorker({
      location: new URL(origin) as unknown as Location,
      registration: { scope: `${origin}/c/assets/` },
      skipWaiting: async () => {},
      addEventListener: (type, callback) => { handlers[type] = callback; },
    });
    const postMessage = vi.fn();
    handlers.message!({
      source: { url: `${origin}/c/transfers` },
      ports: [{ postMessage }],
      data: { type: 'tabledb-download', baseUrl, path, serverPublicKey: 'test-key' },
    });
    return postMessage.mock.calls[0]![0];
  }

  it.each(['/api/v1', '/c/api/v1'])('accepts downloads under %s', (base) => {
    expect(register(`${origin}${base}`, `${base}/transfers/123/download?t=token`).url)
      .toMatch(/^http:\/\/localhost:8080\/c\/assets\/tabledb-download\//);
  });

  it.each([
    '/api/v1/transfers/123/download?t=token',
    '/c/api/v1/auth/me?t=token',
    'http://other.invalid/c/api/v1/transfers/123/download?t=token',
  ])('rejects paths outside the configured download endpoint: %s', (path) => {
    expect(register(`${origin}/c/api/v1`, path)).toEqual({ error: true });
  });
});
