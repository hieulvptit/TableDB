import { t } from '../../i18n';
import { GatewayError } from '../../gateway/types';
import { toGatewayError } from '../../gateway/errors';

export interface FriendlyError { title: string; detail: string; code: string; sqlState?: string; cancelled: boolean }

const KNOWN = ['E_BAD_REQUEST', 'E_DRIVER_UNAVAILABLE', 'E_AUTH_FAILED', 'E_AUTH_INTERACTIVE_TIMEOUT', 'E_CONN', 'E_TIMEOUT', 'E_CANCELLED', 'E_READONLY_VIOLATION', 'E_POLICY', 'E_SQL', 'E_LIMIT', 'E_NOT_FOUND', 'E_INTERNAL', 'E_SSH_HOSTKEY', 'E_SSH_AUTH', 'E_PROXY_AUTH'] as const;

/** Vietnamese, user-facing error for sidecar/API errors. The raw server message (already secret-free) is shown as detail. */
export function friendlyDbError(e: unknown): FriendlyError {
  const g: GatewayError = toGatewayError(e);
  const known = (KNOWN as readonly string[]).includes(g.code);
  const title = known ? t(`dberr.${g.code}` as never) : g.code === 'FORBIDDEN' ? t('dberr.FORBIDDEN') : g.code === 'NETWORK' ? t('dberr.NETWORK') : t('dberr.unknown');
  return { title, detail: g.message, code: g.code, sqlState: g.sqlState, cancelled: g.code === 'E_CANCELLED' || g.code === 'ABORTED' };
}
