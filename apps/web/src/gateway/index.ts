import { TauriGateway } from './TauriGateway';
import type { DbGateway } from './types';

/** The desktop app talks to databases only through the local sidecar (Rust core, stdio NDJSON). There is no HTTP/remote gateway. */
export const createGateway = (): DbGateway => new TauriGateway();
export * from './types';
export { DbApi } from './dbApi';
