/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_TARGET?: 'web' | 'desktop';
  /** API base, default "/api/v1" (relative; proxied in dev, same-origin in prod) */
  readonly VITE_API_BASE?: string;
  /** label shown in header env badge on web: test | prod */
  readonly VITE_ENV?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
