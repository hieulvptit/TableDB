import type { SQLNamespace } from '@codemirror/lang-sql';
import type { TableMeta } from '@vnpay/shared';
import type { DbApi } from '../../gateway';
import type { ColumnsResult, TableInfo } from '../../gateway/types';

export interface TableRef { catalog?: string; schema: string; name: string }
export const catKey = (c?: string | null) => c ?? '';
export const schemaKey = (c: string | undefined, s: string) => `${catKey(c)}\u0001${s}`;
export const tableKey = (r: TableRef) => `${catKey(r.catalog)}\u0001${r.schema}\u0001${r.name}`;

interface Entry<T> { status: 'loading' | 'ready' | 'error'; value?: T; error?: string }

/**
 * Lazy metadata cache for one DB session. Everything the tree, the SQL autocomplete and the Agent context use comes
 * from here — i.e. only what the user's own session was allowed to see.
 */
export class SchemaStore {
  private catalogsE: Entry<string[]> | undefined;
  private schemasE = new Map<string, Entry<string[]>>();
  private tablesE = new Map<string, Entry<TableInfo[]>>();
  private colsE = new Map<string, Entry<ColumnsResult>>();
  private ddlE = new Map<string, Entry<string>>();
  /** anything else loaded for this session (object folders, sources, …) under a caller-chosen key */
  private extraE = new Map<string, Entry<unknown>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private nsCache: { version: number; ns: SQLNamespace } | undefined;
  constructor(private api: DbApi) {}

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  private bump() { this.version++; this.listeners.forEach((l) => l()); }

  catalogs() { return this.catalogsE; }
  schemas(catalog?: string) { return this.schemasE.get(catKey(catalog)); }
  tables(catalog: string | undefined, schema: string) { return this.tablesE.get(schemaKey(catalog, schema)); }
  columns(r: TableRef) { return this.colsE.get(tableKey(r)); }
  ddl(r: TableRef) { return this.ddlE.get(tableKey(r)); }

  private async load<T>(map: Map<string, Entry<T>>, key: string, fn: () => Promise<T>, force = false): Promise<T | undefined> {
    const cur = map.get(key);
    if (cur && !force && (cur.status === 'ready' || cur.status === 'loading')) return cur.value;
    map.set(key, { status: 'loading' });
    this.bump();
    try {
      const value = await fn();
      map.set(key, { status: 'ready', value });
      this.bump();
      return value;
    } catch (e) {
      map.set(key, { status: 'error', error: (e as Error).message });
      this.bump();
      return undefined;
    }
  }

  async loadCatalogs(force = false) {
    const cur = this.catalogsE;
    if (cur && !force && cur.status !== 'error') return cur.value;
    this.catalogsE = { status: 'loading' }; this.bump();
    try { const v = await this.api.catalogs(); this.catalogsE = { status: 'ready', value: v }; this.bump(); return v; }
    catch (e) { this.catalogsE = { status: 'error', error: (e as Error).message }; this.bump(); return undefined; }
  }
  loadSchemas(catalog?: string, force = false) { return this.load(this.schemasE, catKey(catalog), () => this.api.schemas(catalog), force); }
  loadTables(catalog: string | undefined, schema: string, force = false) { return this.load(this.tablesE, schemaKey(catalog, schema), () => this.api.tables(schema, catalog), force); }
  loadColumns(r: TableRef, force = false) { return this.load(this.colsE, tableKey(r), () => this.api.columns(r.schema, r.name, r.catalog), force); }
  loadDdl(r: TableRef, force = false) { return this.load(this.ddlE, tableKey(r), async () => (await this.api.ddl(r.schema, r.name, r.catalog)).ddl, force); }

  extra<T>(key: string) { return this.extraE.get(key) as Entry<T> | undefined; }
  loadExtra<T>(key: string, fn: () => Promise<T>, force = false) { return this.load(this.extraE as Map<string, Entry<T>>, key, fn, force); }

  /** every loaded table list, with its catalog/schema */
  loadedTables(): Array<{ catalog?: string; schema: string; tables: TableInfo[] }> {
    const out: Array<{ catalog?: string; schema: string; tables: TableInfo[] }> = [];
    for (const [key, e] of this.tablesE) {
      if (e.status !== 'ready' || !e.value) continue;
      const [catalog, schema] = key.split('\u0001') as [string, string];
      out.push({ ...(catalog ? { catalog } : {}), schema, tables: e.value });
    }
    return out;
  }

  clear() {
    this.catalogsE = undefined; this.schemasE.clear(); this.tablesE.clear(); this.colsE.clear(); this.ddlE.clear(); this.extraE.clear(); this.bump();
  }

  /** Table metadata for the Agent, built ONLY from what has been loaded (columns loaded => table is "accessible"). */
  accessibleMetas(): TableMeta[] {
    const out: TableMeta[] = [];
    for (const [key, e] of this.colsE) {
      if (e.status !== 'ready' || !e.value) continue;
      const [catalog, schema, name] = key.split('\u0001') as [string, string, string];
      const info = this.tablesE.get(schemaKey(catalog || undefined, schema))?.value?.find((t) => t.name === name);
      const ddl = this.ddlE.get(key)?.value;
      out.push({
        catalog: catalog || null, schema, name, type: info?.type, remarks: info?.remarks ?? null,
        columns: e.value.columns.map((c) => ({ name: c.name, typeName: c.typeName, nullable: c.nullable, remarks: c.remarks ?? null })),
        primaryKey: e.value.primaryKey,
        foreignKeys: e.value.foreignKeys.map((f) => ({ columns: f.columns, refSchema: f.refSchema, refTable: f.refTable, refColumns: f.refColumns })),
        ddl: ddl ?? null,
      });
    }
    return out;
  }

  /**
   * CodeMirror SQLNamespace from loaded metadata only (empty when nothing loaded): every loaded schema at the top level
   * ({schema: {table: [columns]}}, schemas whose tables are not loaded yet as {}), plus each catalog/database with its
   * schemas under it ({catalog: {schema: {table: [columns]}}}). Cached per store version.
   */
  sqlNamespace(): SQLNamespace {
    if (this.nsCache?.version === this.version) return this.nsCache.ns;
    type Schemas = Record<string, Record<string, string[]>>;
    const byCat = new Map<string, Schemas>();
    const cat = (c: string) => { let m = byCat.get(c); if (!m) byCat.set(c, (m = {})); return m; };
    for (const [c, e] of this.schemasE) {
      if (e.status !== 'ready' || !e.value) continue;
      const m = cat(c);
      for (const s of e.value) m[s] ??= {};
    }
    for (const [key, e] of this.tablesE) {
      if (e.status !== 'ready' || !e.value) continue;
      const [c, schema] = key.split('\u0001') as [string, string];
      const s = (cat(c)[schema] = {} as Record<string, string[]>);
      for (const t of e.value) s[t.name] = this.colsE.get(`${key}\u0001${t.name}`)?.value?.columns.map((col) => col.name) ?? [];
    }
    const ns: Record<string, Record<string, unknown>> = {};
    for (const m of byCat.values()) for (const [s, tables] of Object.entries(m)) ns[s] = { ...ns[s], ...tables };
    for (const c of this.catalogsE?.value ?? []) ns[c] = { ...ns[c], ...byCat.get(c) };
    this.nsCache = { version: this.version, ns: ns as SQLNamespace };
    return this.nsCache.ns;
  }
}
