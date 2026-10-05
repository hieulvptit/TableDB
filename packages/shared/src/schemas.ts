// Request/response DTOs shared by API and SPA.
import { z } from 'zod';
import { TICKET_STATUSES, NOTIFY_STATES, TRANSFER_DIRECTIONS } from './ticket-state.js';

export const DriverType = z.enum(['oracle', 'trino', 'postgresql']);
export type DriverType = z.infer<typeof DriverType>;

export const UploadInit = z.object({
  fileName: z.string().min(1).max(255),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  purpose: z.string().min(5).max(1000),
  approverId: z.string().uuid(),
  recipientIds: z.array(z.string().uuid()).max(20).default([]),
});
export type UploadInit = z.infer<typeof UploadInit>;

export const DecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(1000).optional(),
}).refine((b) => b.decision === 'approve' || (b.reason && b.reason.trim().length >= 3), { message: 'reason required when rejecting', path: ['reason'] });

export const TicketView = z.object({
  id: z.string(), code: z.string(), status: z.enum(TICKET_STATUSES), notifyState: z.enum(NOTIFY_STATES),
  fileName: z.string(), size: z.number(), sha256: z.string(), purpose: z.string(),
  requesterId: z.string(), approverId: z.string(), approverEmail: z.string().nullable().optional(), approverName: z.string().nullable().optional(), direction: z.enum(TRANSFER_DIRECTIONS),
  createdAt: z.string(), expiresAt: z.string().nullable(), downloadCount: z.number(), maxDownloads: z.number(),
  decisionReason: z.string().nullable().optional(),
});
export type TicketView = z.infer<typeof TicketView>;

export const AgentChatBody = z.object({
  connectionId: z.string(),
  dialect: DriverType,
  connectionName: z.string().max(100),
  selectedCatalog: z.string().max(200).nullish(),
  selectedSchema: z.string().max(200).nullish(),
  selectedTables: z.array(z.object({ schema: z.string(), name: z.string() })).max(20),
  /** metadata as observed by the caller's DB session; server re-sanitizes and enforces budget */
  accessible: z.array(z.object({
    catalog: z.string().nullish(), schema: z.string(), name: z.string(), type: z.string().optional(), remarks: z.string().nullish(),
    columns: z.array(z.object({ name: z.string(), typeName: z.string(), nullable: z.boolean().optional(), remarks: z.string().nullish() })).max(600),
    primaryKey: z.array(z.string()).optional(),
    foreignKeys: z.array(z.object({ columns: z.array(z.string()), refSchema: z.string(), refTable: z.string(), refColumns: z.array(z.string()) })).optional(),
    ddl: z.string().nullish(),
  })).max(200),
  expandRelated: z.boolean().default(false),
  /** `images` (pasted/uploaded screenshots as data URLs, already downscaled by the client) are honoured on the last user message only */
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']), content: z.string().max(8000),
    images: z.array(z.string().max(700_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/)).max(3).optional(),
  })).min(1).max(40),
  /** endpoint + model picked in the Agent popup; defaults to the ones the token was verified with */
  endpointId: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  rows: z.object({ confirmed: z.literal(true), columns: z.array(z.string()), rows: z.array(z.array(z.unknown())).max(20) }).optional(),
  /** let the Agent look up business metadata in OpenMetadata (only when the admin configured it and the user stored a token) */
  useOpenMetadata: z.boolean().default(true),
  /** user-confirmed business notes saved for this connection (client workspace); sent as fenced reference data */
  dataContext: z.string().max(4000).optional(),
  /** single LLM call, no metadata/tools (conversation summaries) */
  plain: z.boolean().default(false),
});
export type AgentChatBody = z.infer<typeof AgentChatBody>;
