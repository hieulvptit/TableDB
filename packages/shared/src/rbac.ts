// Authorization decisions. Pure functions: the API calls these on every request; the UI may call them only to hide controls.

export type Role = 'user' | 'leader' | 'admin' | 'service';
export type Permission =
  | 'db:connect' | 'db:read' | 'db:write' | 'db:custom'
  | 'agent:use'
  | 'transfer:create' | 'transfer:approve' | 'transfer:download'
  | 'admin:manage' | 'audit:read'
  | 'integration:mail' | 'integration:file' | 'integration:agent' | 'integration:db';

const ROLE_PERMS: Record<Role, Permission[]> = {
  user: ['db:connect', 'db:read', 'db:custom', 'agent:use', 'transfer:create', 'transfer:download'],
  leader: ['db:connect', 'db:read', 'db:custom', 'agent:use', 'transfer:create', 'transfer:download', 'transfer:approve'],
  admin: ['db:connect', 'db:read', 'db:custom', 'agent:use', 'transfer:create', 'transfer:download', 'admin:manage', 'audit:read'],
  service: [],
};

export interface Principal {
  id: string;
  roles: Role[];
  /** extra per-user grants (e.g. db:write, db:custom) or, for service principals, integration scopes */
  grants: Permission[];
  active: boolean;
}

export function permissionsOf(p: Principal): Set<Permission> {
  const s = new Set<Permission>(p.grants);
  for (const r of p.roles) for (const perm of ROLE_PERMS[r] ?? []) s.add(perm);
  return s;
}

export function hasPermission(p: Principal | null | undefined, perm: Permission): boolean {
  return !!p && p.active && permissionsOf(p).has(perm);
}

// ---- ticket-level policy -------------------------------------------------------------

import { downloadClientFor, type ClientKind, type TicketStatus, type TransferDirection } from './ticket-state.js';

export interface TicketRef {
  id: string;
  requesterId: string;
  approverId: string;
  recipientIds: string[];
  status: TicketStatus;
  expiresAt: Date | null;
  downloadCount: number;
  maxDownloads: number;
  /** absent only in UI-built refs that do not care (e.g. revoke) */
  direction?: TransferDirection;
}
export interface Delegation {
  fromUserId: string;
  toUserId: string;
  validFrom: Date;
  validTo: Date;
  revoked: boolean;
}

export function activeDelegateFor(approverId: string, userId: string, delegations: Delegation[], now: Date): boolean {
  return delegations.some(
    (d) => !d.revoked && d.fromUserId === approverId && d.toUserId === userId && d.validFrom <= now && now <= d.validTo,
  );
}

export type Decision = { allow: true } | { allow: false; reason: string };
const deny = (reason: string): Decision => ({ allow: false, reason });
const ok: Decision = { allow: true };

export function canApprove(p: Principal, t: TicketRef, delegations: Delegation[], now: Date): Decision {
  if (!hasPermission(p, 'transfer:approve')) return deny('missing transfer:approve');
  if (p.id === t.requesterId) return deny('requester cannot decide own ticket');
  if (t.status !== 'PENDING_APPROVAL') return deny(`ticket is ${t.status}`);
  if (t.expiresAt && t.expiresAt <= now) return deny('ticket expired');
  if (p.id === t.approverId || activeDelegateFor(t.approverId, p.id, delegations, now)) return ok;
  return deny('not the designated approver or delegate');
}

/** `client` = kind of the caller's session. When both it and the ticket direction are known, only the destination side may download. */
export function canDownload(p: Principal, t: TicketRef, now: Date, client?: ClientKind): Decision {
  if (!hasPermission(p, 'transfer:download')) return deny('missing transfer:download');
  if (client && t.direction && client !== downloadClientFor(t.direction)) return deny(`this file can only be downloaded from the ${downloadClientFor(t.direction)} app`);
  if (t.status !== 'APPROVED' && t.status !== 'DOWNLOADED') return deny(`ticket is ${t.status}`);
  if (t.expiresAt && t.expiresAt <= now) return deny('ticket expired');
  if (t.downloadCount >= t.maxDownloads) return deny('download limit reached');
  if (p.id !== t.requesterId && !t.recipientIds.includes(p.id)) return deny('not a permitted downloader');
  return ok;
}

export function canView(p: Principal, t: TicketRef, delegations: Delegation[], now: Date): Decision {
  if (hasPermission(p, 'audit:read')) return ok;
  if (p.id === t.requesterId || p.id === t.approverId || t.recipientIds.includes(p.id)) return ok;
  if (activeDelegateFor(t.approverId, p.id, delegations, now)) return ok;
  return deny('no access to ticket');
}

export function canRevoke(p: Principal, t: TicketRef): Decision {
  const live: TicketStatus[] = ['UPLOADING', 'SCANNING', 'PENDING_APPROVAL', 'APPROVED', 'DOWNLOADED'];
  if (!live.includes(t.status)) return deny(`ticket is ${t.status}`);
  if (p.id === t.requesterId || hasPermission(p, 'admin:manage')) return ok;
  return deny('only requester or admin can revoke');
}
