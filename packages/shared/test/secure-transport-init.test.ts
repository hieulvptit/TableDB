import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSecureFetch } from '../src/secure-transport';
import { WEB_SERVER_PUBLIC_KEY } from '../src/secure-pins';

describe('Secure API initialization', () => {
  const options = { baseUrl: '/api/v1', clientKind: 'web' as const, serverPublicKey: WEB_SERVER_PUBLIC_KEY };

  it('explains the secure-context requirement before making a request', () => {
    const fetchImpl = vi.fn();
    expect(() => createSecureFetch({ ...options, cryptoImpl: {} as Crypto, fetchImpl })).toThrow('Open the web app over HTTPS or use http://localhost');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an absent public key separately from unavailable WebCrypto', () => {
    for (const serverPublicKey of ['', '   ']) {
      expect(() => createSecureFetch({ ...options, serverPublicKey, cryptoImpl: webcrypto as unknown as Crypto })).toThrow('VITE_SECURE_WEB_PUBLIC_KEY');
    }
  });

  it('initializes without network traffic when WebCrypto and the pin are available', () => {
    const fetchImpl = vi.fn();
    expect(createSecureFetch({ ...options, cryptoImpl: webcrypto as unknown as Crypto, fetchImpl })).toBeTypeOf('function');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
