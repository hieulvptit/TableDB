import type { StoredTokens, TokenStore } from '../api/tokens';
import { desktopCommands } from './tauri';

/** ONE credential-manager item holds the whole session. Every read/write of a separate item can raise its own
 *  "allow access to Keychain" prompt on macOS (and each blocks the app until answered), so keep it to a single item. */
const KEY = 'auth.session';

interface Stored { a: string; r: string; e: number }

/** Desktop: tokens live in the OS credential manager through Tauri secret_* commands; a memory copy avoids IPC per request. */
export class SecretTokenStore implements TokenStore {
  private cache: StoredTokens | null | undefined;
  private loading: Promise<StoredTokens | null> | null = null;

  /** Concurrent callers share ONE read (previously each started its own 3 keychain reads). */
  load(): Promise<StoredTokens | null> {
    if (this.cache !== undefined) return Promise.resolve(this.cache);
    this.loading ??= this.read().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async read(): Promise<StoredTokens | null> {
    let tokens: StoredTokens | null = null;
    try {
      const raw = await desktopCommands.secretGet(KEY);
      const s = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
      if (s && typeof s.a === 'string' && s.a) tokens = { accessToken: s.a, refreshToken: typeof s.r === 'string' ? s.r : '', expiresAt: Number(s.e ?? 0) };
    } catch { tokens = null; } // unreadable/corrupt item => treat as signed out
    this.cache = tokens;
    return tokens;
  }

  async save(t: StoredTokens) {
    this.cache = t;
    const s: Stored = { a: t.accessToken, r: t.refreshToken ?? '', e: t.expiresAt };
    await desktopCommands.secretSet(KEY, JSON.stringify(s));
  }

  async clear() {
    this.cache = null;
    await desktopCommands.secretDelete(KEY);
  }
}
