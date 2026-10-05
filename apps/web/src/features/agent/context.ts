import type { AgentChatBody } from '@vnpay/shared';
import type { Connection, AgentRowsAttachment, SelectedTable } from '../tabledb/types';
import { tableKey, type TableRef } from '../tabledb/schemaStore';

export const MAX_ROWS_TO_AGENT = 20;

/**
 * Load metadata for the Agent context on demand, through the user's own session:
 *  - the currently selected tables (columns + best-effort DDL) are the default context;
 *  - FK-related tables (one level) are loaded ONLY when `expandRelated` is on (opt-in).
 */
export async function ensureContext(conn: Connection, selected: TableRef[], expandRelated: boolean): Promise<void> {
  const s = conn.store;
  await Promise.all(selected.map((r) => s.loadColumns(r)));
  await Promise.all(selected.map((r) => s.loadDdl(r))); // failure (e.g. E_POLICY) is stored as an error entry and simply omitted
  if (expandRelated) {
    const rel = new Map<string, TableRef>();
    for (const r of selected) {
      for (const fk of s.columns(r)?.value?.foreignKeys ?? []) {
        const ref: TableRef = { catalog: fk.refCatalog ?? r.catalog, schema: fk.refSchema, name: fk.refTable };
        rel.set(tableKey(ref), ref);
      }
    }
    await Promise.all([...rel.values()].map((r) => s.loadColumns(r)));
  }
}

export type PreviewBody = Omit<AgentChatBody, 'messages'>;
export interface AgentLlmChoice { endpointId: string; model: string }

/** Pure: metadata comes only from what the session store already loaded (`accessible` = allow-list). */
export function buildPreviewBody(conn: Pick<Connection, 'id' | 'name' | 'driver' | 'store'>, selected: SelectedTable[], expandRelated: boolean, rows?: AgentRowsAttachment | null, llm?: AgentLlmChoice | null): PreviewBody {
  const accessible = conn.store.accessibleMetas().slice(0, 200).map((m) => ({ ...m, columns: m.columns.slice(0, 600) }));
  const first = selected[0];
  return {
    connectionId: conn.id,
    dialect: conn.driver,
    connectionName: conn.name.slice(0, 100),
    selectedCatalog: first?.catalog ?? null,
    selectedSchema: first?.schema ?? null,
    selectedTables: selected.slice(0, 20).map((r) => ({ schema: r.schema, name: r.name })),
    accessible,
    expandRelated,
    useOpenMetadata: true,
    plain: false,
    ...(llm ? { endpointId: llm.endpointId, model: llm.model } : {}),
    ...(rows && rows.rows.length > 0 ? { rows: { confirmed: true as const, columns: rows.columns, rows: rows.rows.slice(0, MAX_ROWS_TO_AGENT) } } : {}),
  };
}

export function buildChatBody(
  conn: Pick<Connection, 'id' | 'name' | 'driver' | 'store'>, selected: SelectedTable[], expandRelated: boolean,
  messages: Array<{ role: 'user' | 'assistant'; content: string; images?: string[] }>, rows?: AgentRowsAttachment | null, llm?: AgentLlmChoice | null,
  extra: { dataContext?: string; plain?: boolean } = {},
): AgentChatBody {
  return { ...buildPreviewBody(conn, selected, expandRelated, rows, llm), ...(extra.dataContext ? { dataContext: extra.dataContext.slice(0, 4000) } : {}), ...(extra.plain ? { plain: true } : {}), messages: messages.slice(-30).map((m) => ({ role: m.role, content: m.content.slice(0, 8000), ...(m.images?.length ? { images: m.images } : {}) })) };
}
