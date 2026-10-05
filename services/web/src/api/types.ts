import type { DriverType, TicketView, Permission, Role, NotifyState, TicketStatus } from '@vnpay/shared';

export type { TicketView, DriverType, Permission, Role, NotifyState, TicketStatus };

export interface Me {
  user: { id: string; email: string; name: string; roles: Role[]; permissions: Permission[] };
  csrfToken: string;
  authTime: string | number;
  kind: 'web' | 'desktop'; // as returned by /auth/me; the BO portal is always 'web'
}
export interface AuthConfig { providers: Array<{ id: string; label: string }>; devLogin: boolean }

export interface TransferOptions {
  leaders: Array<{ id: string; name: string; email: string }>;
  limits: { maxBytes: number; partBytes: number; allowedExtensions: string[]; defaultTtlHours: number; maxDownloads: number };
}
export interface TicketEvent { id?: string | number; at?: string; actor_id?: string | null; kind?: string; data?: Record<string, unknown> | null }
export interface PersonRef { id: string; name: string; email: string }
export interface UploadInfo { startedAt?: string | null; completedAt?: string | null; durationMs?: number | null; parts?: number | null; throughputBps?: number | null; clientKind?: 'web' | 'desktop' | null; clientIp?: string | null; userAgent?: string | null }
export interface FileTypeInfo { declaredExt: string; detected: string; label: string; mismatch: boolean; mismatchNote?: string; executable: boolean }
export interface ScanInfo { reason?: string; result: 'clean' | 'infected' | 'skipped' | null; signature?: string; scannedAt?: string | null }
export interface PiiReport { detected: boolean; categories: string[]; chunks: number; engine: string; coverage?: string; sampledLines?: number; totalLines?: number; listedFiles?: number; encryptedFiles?: number; reason?: string }
export interface SensitiveCounts { phone: number; email: number; idNumber: number; card: number }
export interface CsvInfo { delimiter: string; columns: number; headerNames: string[]; headerTruncated: boolean; dataRows: number; raggedRows: number }
export interface JsonInfo { valid: boolean; topLevel: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'; length: number; maxDepth: number; error?: string }
export interface TextInfo {
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'other'; lines: number; bytes: number; emptyLines: number; maxLineBytes: number;
  csv?: CsvInfo; json?: JsonInfo; jsonl?: { validLines: number; invalidLines: number };
}
export interface ZipInfo { entryCount: number; fileCount: number; dirCount: number; totalCompressed: number; totalUncompressed: number; encryptedCount: number; zipSlipCount: number; nestedArchiveCount: number; maxRatio: number; inspectedEntries: number }
export interface ManifestSummary {
  version: number; size: number; sha256: string; declaredExt: string; detectedType: string; label: string; typeMismatch: boolean; mismatchNote?: string;
  executable: boolean; containsExecutable?: boolean; containsSensitivePatterns: boolean; sensitive?: SensitiveCounts; truncated: boolean; truncatedReason?: string; text?: TextInfo; zip?: ZipInfo;
}
export type EntryFlag = 'executable' | 'sensitive' | 'encrypted' | 'zip-slip' | 'unreadable' | 'mismatch' | 'nested-archive' | 'too-large' | 'bomb-ratio' | 'size-mismatch' | 'crc-error';
export interface ManifestEntry {
  idx: number; path: string; isDir: boolean; compressedSize: number; size: number; modified: string; crc32: string; sha256?: string;
  encrypted: boolean; zipSlip: boolean; nested: boolean; depth: number; detectedType?: string; lines?: number; flags: EntryFlag[] | string[];
}
export interface ManifestView {
  status: 'ok' | 'error'; inspectError?: string; inspectedAt: string; durationMs: number; manifestHash: string; summary: ManifestSummary;
  entries: { offset: number; limit: number; total: number; items: ManifestEntry[] };
}
export interface TicketDetail {
  ticket: TicketView; events: TicketEvent[]; receivedParts: number[]; totalParts: number;
  uploader?: PersonRef | null; upload?: UploadInfo | null; fileType?: FileTypeInfo | null; scan?: ScanInfo | null; manifest?: ManifestView | null; pii?: PiiReport | null;
}
export interface UploadInitResult { ticket: TicketView; partBytes: number; totalParts: number }
export interface Delegation { id: string; fromUserId?: string; toUserId: string; toUserName?: string; validFrom: string; validTo: string; revoked?: boolean }

export interface AuditEntry { seq: number; at: string; actorId?: string | null; actorLabel?: string | null; action: string; resourceType?: string | null; resourceId?: string | null; ip?: string | null; detail?: unknown; prevHash?: string; hash?: string }
export interface TraceResult { ticket: { id: string; code: string }; entries: AuditEntry[] }
export interface AuditVerify { ok: boolean; checked?: number; brokenAtSeq?: number }
