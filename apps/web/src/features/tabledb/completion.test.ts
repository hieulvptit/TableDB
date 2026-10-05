import { describe, expect, it } from 'vitest';
import { autocompletion, CompletionContext, currentCompletions, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { completionSources, lazyMetaSource, statementColumnsSource } from './completion';
import { SchemaStore } from './schemaStore';

const slow = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 20));
const mkStore = (db = 'postgrefu') => new SchemaStore({
  catalogs: async () => slow([db]),
  schemas: async () => slow(['crm', 'public', 'sales']),
  tables: async (s: string) => (s === 'public' ? [{ name: 'orders', type: 'TABLE' }] : [{ name: 'deals', type: 'TABLE' }]),
  columns: async (_s: string, t: string) => ({ columns: t === 'orders' ? [{ name: 'id', typeName: 'int4' }, { name: 'total', typeName: 'numeric' }] : [{ name: 'deal_id', typeName: 'int8' }], primaryKey: [], foreignKeys: [] }),
} as never);

/** runs the editor's sources at `|` (lazy loads awaited, then queried again as the reopened list would be) */
async function complete(store: SchemaStore, text: string, explicit = false): Promise<string[]> {
  const pos = text.indexOf('|');
  const state = EditorState.create({ doc: text.replace('|', ''), extensions: [sql({ dialect: PostgreSQL })] });
  const schema = () => 'public';
  const srcs = completionSources(PostgreSQL, () => store.sqlNamespace(), [lazyMetaSource(() => store, schema), statementColumnsSource(() => store, schema)], schema);
  const run = async () => (await Promise.all(srcs.map((s) => s(new CompletionContext(state, pos, explicit))))).filter(Boolean) as CompletionResult[];
  for (let i = 0; i < 6; i++) { await run(); await new Promise((r) => setTimeout(r, 30)); }
  const kw = new Set((await run()).flatMap((r) => r.options.filter((o) => o.type === 'keyword').map((o) => o.label)));
  return (await run()).flatMap((r) => r.options.map((o) => o.label)).filter((l) => !kw.has(l));
}

describe('SQL completion of databases, schemas, tables, columns', () => {
  it('namespace: database → schema → table → columns, schemas also at the top level', async () => {
    const st = mkStore();
    await st.loadCatalogs(); await st.loadSchemas('postgrefu'); await st.loadTables('postgrefu', 'public');
    expect(st.sqlNamespace()).toEqual({ postgrefu: { crm: {}, public: { orders: [] }, sales: {} }, crm: {}, public: { orders: [] }, sales: {} });
  });
  it('db. → schemas', async () => {
    expect(await complete(mkStore(), 'SELECT * FROM postgrefu.|')).toEqual(expect.arrayContaining(['public', 'sales']));
  });
  it('db.schema. → tables, loaded on demand', async () => {
    expect(await complete(mkStore(), 'SELECT * FROM postgrefu.sales.|')).toContain('deals');
    expect(await complete(mkStore(), 'SELECT * FROM sales.|')).toContain('deals');
  });
  it('db.schema.table. / alias. → columns', async () => {
    expect(await complete(mkStore(), 'SELECT postgrefu.public.orders.| FROM postgrefu.public.orders')).toEqual(expect.arrayContaining(['id', 'total']));
    expect(await complete(mkStore(), 'SELECT o.| FROM sales.deals d JOIN orders o ON true')).toEqual(expect.arrayContaining(['id', 'total']));
  });
  it('bare columns of the tables in FROM, also before the FROM', async () => {
    const got = await complete(mkStore(), 'SELECT | FROM postgrefu.public.orders o, sales.deals', true);
    expect(got).toEqual(expect.arrayContaining(['id', 'total', 'deal_id']));
    expect(await complete(mkStore(), 'SELECT * FROM postgrefu.public.orders WHERE to|')).toContain('total');
  });
  it('database, schemas and default-schema tables at the top level', async () => {
    expect(await complete(mkStore(), 'SELECT * FROM |', true)).toEqual(expect.arrayContaining(['postgrefu', 'public', 'sales', 'orders']));
  });
});

/** types into a real editor (the autocompletion plugin drives the sources) and returns the open list */
async function typeLive(store: SchemaStore, text: string): Promise<string[]> {
  const schema = () => 'public';
  const view = new EditorView({ parent: document.body, state: EditorState.create({ extensions: [
    sql({ dialect: PostgreSQL }),
    autocompletion({ override: completionSources(PostgreSQL, () => store.sqlNamespace(), [lazyMetaSource(() => store, schema), statementColumnsSource(() => store, schema)], schema) }),
  ] }) });
  view.focus();
  for (const ch of text) view.dispatch({ changes: { from: view.state.doc.length, insert: ch }, selection: { anchor: view.state.doc.length + 1 }, userEvent: 'input.type' });
  await new Promise((r) => setTimeout(r, 400));
  const out = currentCompletions(view.state).map((o) => o.label);
  view.destroy();
  return out;
}

describe('SQL completion while typing (live editor)', () => {
  it('db. lists the schemas even when nothing was loaded before', async () => {
    expect(await typeLive(mkStore(), 'SELECT * FROM postgrefu.')).toEqual(['crm', 'public', 'sales']);
  });
  it('db.C offers matching schemas only, no keywords (CALL, CASE…) after a dot', async () => {
    const got = await typeLive(mkStore(), 'SELECT * FROM postgrefu.C');
    expect(got).toContain('crm');
    expect(got).not.toContain('CALL');
  });
  it('qualifiers match case-insensitively', async () => {
    expect(await typeLive(mkStore('PostgreFU'), 'SELECT * FROM postgrefu.')).toEqual(['crm', 'public', 'sales']);
    expect(await typeLive(mkStore(), 'SELECT * FROM POSTGREFU.PUBLIC.')).toEqual(['orders']);
  });
});
