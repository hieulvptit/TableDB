export interface StoredTokens { accessToken: string; refreshToken: string; expiresAt: number /* epoch ms */ }
export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(t: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  constructor(private t: StoredTokens | null = null) {}
  async load() { return this.t; }
  async save(t: StoredTokens) { this.t = t; }
  async clear() { this.t = null; }
}

export function toEpochMs(v: string | number): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(v);
  return Number.isNaN(d) ? 0 : d;
}
