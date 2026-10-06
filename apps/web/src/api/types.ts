import type { AgentRuntimeConfig } from '../features/agent/runtimeConfig';
import type { DriverType, TicketView, Permission, Role, NotifyState, TicketStatus } from '@vnpay/shared';

export type { TicketView, DriverType, Permission, Role, NotifyState, TicketStatus };

export interface Me {
  user: { id: string; email: string; name: string; roles: Role[]; permissions: Permission[] };
  csrfToken: string;
  authTime: string | number;
  kind: 'web' | 'desktop';
}
export interface AuthConfig { providers: Array<{ id: string; label: string }>; devLogin: boolean; /** Desktop only: VNPAY SSO broker login URL; null/absent -> use the OIDC provider flow. */ desktopLoginUrl?: string | null }
export interface DesktopAuthConfig { authorizeEndpoint: string; clientId: string; scopes: string[]; redirectUriTemplate: string }
export interface TokenBundle { accessToken: string; expiresAt: string | number; refreshToken: string; user?: Me['user'] }

export type AuthMode = 'password' | 'trino-external';
/** GET /db/targets: the admin-defined catalog of targets the desktop may connect to. `proxy`/`options` (when present) come only from here. */
export interface DbTarget {
  id: string; name: string; driver: DriverType; host: string; port: number; database?: string | null;
  allowWrite: boolean; authModes: AuthMode[]; requiresProxy?: boolean;
  proxy?: { type: 'http' | 'socks'; host: string; port: number } | null;
  options?: { ssl?: boolean; connectTimeoutSec?: number } | null;
}

export interface AgentSettings {
 runtime: AgentRuntimeConfig; endpoints: Array<{ id: string; label: string; models: string[]; description?: string }>; defaultEndpointId: string; defaultModel: string; budgetChars: number; openMetadataEnabled?: boolean }
export interface AgentTokenState { configured: boolean; endpointId?: string; model?: string; lastVerifiedAt?: string | null }
export interface OpenMetadataTokenState { enabled: boolean; configured: boolean; lastVerifiedAt: string | null }
export interface AgentToolCall { tool: string; ok: boolean; depth?: number }
export interface AgentTraceEvent { kind: 'thinking' | 'tool' | 'subagent' | 'nudge' | 'compact' | 'final'; name: string; ok: boolean; ms: number; depth: number; note?: string }
export interface AgentAsk { question: string; options: string[] }
export interface AgentProposal { kind: 'entity' | 'terminology' | 'filter' | 'metric' | 'gotcha'; text: string }
export interface AgentChatResult { reply: string; sql: AgentSqlBlock[]; manifest: import('@vnpay/shared').ContextManifest; toolCalls?: AgentToolCall[]; trace?: AgentTraceEvent[]; proposals?: AgentProposal[]; ask?: AgentAsk | null }
export interface AgentSqlBlock { sql: string; kind: 'read' | 'write' | 'ddl' | 'other'; multi: boolean }

export interface TransferOptions {
  upload: { parallelism: number; maxRetries: number; retryBaseMs: number };
  approval: { windowHours: number; delegationMaxDays: number };
  download: { tokenTtlSec: number; reauthMaxAgeSec: number };
  leaders: Array<{ id: string; name: string; email: string }>;
  limits: { maxBytes: number; partBytes: number; allowedExtensions: string[]; defaultTtlHours: number; maxDownloads: number };
}
export interface TicketEvent { id?: string | number; at?: string; actor_id?: string | null; kind?: string; data?: Record<string, unknown> | null }
export interface TicketDetail { ticket: TicketView; events: TicketEvent[]; receivedParts: number[]; totalParts: number }
export interface UploadInitResult { ticket: TicketView; partBytes: number; totalParts: number }
export interface Delegation { id: string; fromUserId?: string; toUserId: string; toUserName?: string; validFrom: string; validTo: string; revoked?: boolean }

export interface AuditEntry { seq: number; at: string; actorId?: string | null; actorLabel?: string | null; action: string; resourceType?: string | null; resourceId?: string | null; ip?: string | null; detail?: unknown }
export interface AuditVerify { ok: boolean; checked?: number; brokenAtSeq?: number }
