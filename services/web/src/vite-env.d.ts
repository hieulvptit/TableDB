/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** API base, default "/api/v1" (relative; proxied in dev, same-origin in prod) */
  readonly VITE_API_BASE?: string;
  /** label shown in header env badge: test | prod */
  readonly VITE_ENV?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
