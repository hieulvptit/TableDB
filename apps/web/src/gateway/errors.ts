import { ApiError } from '../api/errors';
import { GatewayError } from './types';

/** Normalise anything thrown by a transport into GatewayError (sidecar E_* codes preserved). */
export function toGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  if (e instanceof ApiError) {
    const d = e.details as { code?: string; sqlState?: string; retryable?: boolean } | undefined;
    const code = typeof d?.code === 'string' && d.code.startsWith('E_') ? d.code : e.code;
    return new GatewayError(code, e.message, d?.sqlState, d?.retryable ?? false, e.status);
  }
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown; sqlState?: unknown; retryable?: unknown; details?: unknown };
    if (typeof o.code === 'string') {
      const g = new GatewayError(o.code, String(o.message ?? o.code), typeof o.sqlState === 'string' ? o.sqlState : undefined, o.retryable === true);
      if (o.details && typeof o.details === 'object' && !Array.isArray(o.details)) g.details = o.details as Record<string, unknown>;
      return g;
    }
    if (typeof o.message === 'string') return new GatewayError('E_INTERNAL', o.message);
  }
  if (typeof e === 'string') return new GatewayError('E_INTERNAL', e);
  return new GatewayError('E_INTERNAL', 'Unknown error');
}
