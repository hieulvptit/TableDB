import { afterEach, expect, it, vi } from 'vitest';
import { nativeApiFetch } from './apiTransport';
import { desktopCommands } from './tauri';

vi.mock('./tauri', () => ({ desktopCommands: { apiHttpStart: vi.fn(), apiHttpRead: vi.fn(), apiHttpClose: vi.fn(async () => {}) } }));
afterEach(() => vi.clearAllMocks());
const base = 'http://localhost:8080/api/v1';
const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"clientKind":"desktop"}' };

it('uses the pinned native transport and pulls response bytes until EOF', async () => {
  const browserFetch = vi.spyOn(globalThis, 'fetch');
  vi.mocked(desktopCommands.apiHttpStart).mockResolvedValue({ status: 200, contentType: 'application/json' });
  vi.mocked(desktopCommands.apiHttpRead).mockResolvedValueOnce(btoa('{"ok":')).mockResolvedValueOnce(btoa('true}')).mockResolvedValueOnce(null);
  const response = await nativeApiFetch(base)(`${base}/secure/handshake`, init);
  expect(await response.json()).toEqual({ ok: true });
  expect(desktopCommands.apiHttpStart).toHaveBeenCalledWith(expect.any(String), 'handshake', { 'content-type': 'application/json' }, btoa(init.body));
  expect(desktopCommands.apiHttpClose).toHaveBeenCalledTimes(1);
  expect(browserFetch).not.toHaveBeenCalled();
  browserFetch.mockRestore();
});

it('rejects foreign origins and arbitrary plaintext API routes before IPC', async () => {
  const fetch = nativeApiFetch(base);
  for (const url of ['https://evil.test/api/v1/secure/request', `${base}/auth/me`, `${base}/secure/request?redirect=x`]) {
    await expect(fetch(url, init)).rejects.toThrow('Invalid native API envelope');
  }
  expect(desktopCommands.apiHttpStart).not.toHaveBeenCalled();
});

it('cancels native requests and propagates AbortError even when abort overtakes start', async () => {
  let resolve!: (value: { status: number; contentType: string }) => void;
  vi.mocked(desktopCommands.apiHttpStart).mockImplementation(() => new Promise(r => { resolve = r; }));
  const controller = new AbortController();
  const result = nativeApiFetch(base)(`${base}/secure/handshake`, { ...init, signal: controller.signal });
  await vi.waitFor(() => expect(desktopCommands.apiHttpStart).toHaveBeenCalled());
  controller.abort();
  resolve({ status: 200, contentType: 'application/json' });
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(desktopCommands.apiHttpClose).toHaveBeenCalled();
  expect(desktopCommands.apiHttpRead).not.toHaveBeenCalled();
});

it('closes the native stream when the consumer cancels', async () => {
  vi.mocked(desktopCommands.apiHttpStart).mockResolvedValue({ status: 200, contentType: 'application/json' });
  vi.mocked(desktopCommands.apiHttpRead).mockImplementation(() => new Promise(() => {}));
  const response = await nativeApiFetch(base)(`${base}/secure/handshake`, init);
  await response.body!.cancel();
  expect(desktopCommands.apiHttpClose).toHaveBeenCalledTimes(1);
});
