import { afterEach, expect, it, vi } from 'vitest';
import { tauriChannel, tauriListen } from './tauri';

afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it('releases the JavaScript callback after removing a native event listener', async () => {
  const unregisterCallback = vi.fn();
  const invoke = vi.fn(async () => 11);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke, transformCallback: () => 7, unregisterCallback };
  const cleanup = await tauriListen('agent:http-chunk', () => {});
  cleanup();
  await vi.waitFor(() => expect(unregisterCallback).toHaveBeenCalledWith(7));
  expect(invoke).toHaveBeenLastCalledWith('plugin:event|unlisten', { event: 'agent:http-chunk', eventId: 11 });
});

it('releases the callback if native listener registration fails', async () => {
  const unregisterCallback = vi.fn();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => { throw new Error('registration failed'); }, transformCallback: () => 7, unregisterCallback };
  await expect(tauriListen('agent:http-chunk', () => {})).rejects.toThrow('registration failed');
  expect(unregisterCallback).toHaveBeenCalledWith(7);
});

it('orders channel chunks and releases the callback after all messages precede the end marker', () => {
  let receive: (event: unknown) => void = () => {};
  const unregisterCallback = vi.fn(); const text: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(), transformCallback: (cb: (event: unknown) => void) => { receive = cb; return 8; }, unregisterCallback };
  const channel = tauriChannel<string>((value) => text.push(value));
  expect(channel.id).toBe('__CHANNEL__:8');
  receive({ index: 1, message: 'second' }); receive({ index: 2, end: true });
  expect(text).toEqual([]); expect(unregisterCallback).not.toHaveBeenCalled();
  receive({ index: 0, message: 'first' });
  expect(text).toEqual(['first', 'second']);
  expect(unregisterCallback).toHaveBeenCalledWith(8);
  channel.close(); expect(unregisterCallback).toHaveBeenCalledTimes(1);
});
