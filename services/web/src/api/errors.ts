export type ApiErrorCode =
  | 'FORBIDDEN' | 'UNAUTHENTICATED' | 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'RATE_LIMITED' | 'UPSTREAM' | 'INTERNAL' | 'STEPUP_REQUIRED' | 'INSUFFICIENT_STORAGE'
  | 'NETWORK' | 'ABORTED';

export class ApiError extends Error {
  readonly code: ApiErrorCode | string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
  get isStepUp() { return this.code === 'STEPUP_REQUIRED'; }
  get isForbidden() { return this.code === 'FORBIDDEN' || this.status === 403; }
}

/** Map an HTTP response to ApiError following the `{error:{code,message,details}}` envelope. */
export function errorFromResponse(status: number, headers: Headers, body: unknown): ApiError {
  const env = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  const stepup = headers.get('X-Stepup')?.toLowerCase() === 'required';
  const fallback: Record<number, string> = { 400: 'VALIDATION', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 502: 'UPSTREAM', 507: 'INSUFFICIENT_STORAGE' };
  const code = stepup && status === 401 ? 'STEPUP_REQUIRED' : (env?.code ?? fallback[status] ?? 'INTERNAL');
  return new ApiError(code, env?.message ?? `HTTP ${status}`, status, env?.details);
}
