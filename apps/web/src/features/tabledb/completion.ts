import { snippetCompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { PLSQL, PostgreSQL, SQLDialect, StandardSQL, keywordCompletionSource, schemaCompletionSource, type SQLNamespace } from '@codemirror/lang-sql';
import type { DriverType } from '@vnpay/shared';
import { quoteIdent } from './tableSql';
import type { SchemaStore, TableRef } from './schemaStore';
import { getSnippets, snippetTemplate } from './workspace';

/** Trino: ANSI keywords plus the engine's own (no built-in dialect in @codemirror/lang-sql). */
export const TrinoSQL = SQLDialect.define({
  keywords: 'select from where group by having order limit offset fetch first next rows only with recursive as on join inner left right full outer cross natural using union all intersect except distinct ' +
    'insert into values update set delete merge matched when then else end case create table view materialized schema catalog drop alter add column rename to comment if exists not null and or in is like escape between ' +
    'show describe explain analyze analyze_verbose format type distributed logical io validate columns tables schemas catalogs functions session stats partitions grants roles call prepare execute deallocate ' +
    'unnest lateral tablesample bernoulli system window over partition range rows preceding following current row filter within grouping sets cube rollup ordinality array map row cast try_cast at time zone interval ' +
    'true false nulls last asc desc for system_time version',
  types: 'boolean tinyint smallint integer int bigint real double decimal varchar char varbinary json date time timestamp interval array map row ipaddress uuid hyperloglog qdigest',
  builtin: 'count sum avg min max approx_distinct approx_percentile arbitrary array_agg map_agg coalesce nullif greatest least if try date_trunc date_add date_diff date_format date_parse from_unixtime to_unixtime ' +
    'now current_date current_timestamp localtimestamp year month day hour minute second regexp_like regexp_extract regexp_replace split concat substr length lower upper trim replace json_extract json_extract_scalar json_format json_parse ' +
    'cardinality element_at contains array_join transform filter reduce zip sequence round floor ceil abs mod power sqrt ln log10 rand random format_datetime parse_datetime',
});

export function dialectFor(driver: DriverType | undefined): SQLDialect {
  switch (driver) {
    case 'postgresql': return PostgreSQL;
    case 'oracle': return PLSQL;
    case 'trino': return TrinoSQL;
    default: return StandardSQL;
  }
}

/** Saved snippets by name (`${x}` placeholders become tab stops). */
export const snippetSource: CompletionSource = (ctx: CompletionContext): CompletionResult | null => {
  const word = ctx.matchBefore(/[A-Za-z_][\w]*$/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options: Completion[] = getSnippets().map((s) => snippetCompletion(snippetTemplate(s.sql), { label: s.name, detail: s.description ?? 'snippet', type: 'text', boost: -1 }));
  return { from: word.from, options, validFor: /^\w*$/ };
};

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$#]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
const partsOf = (q: string) => q.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(unquote);
const NOT_ALIAS = new Set(['ON', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'ORDER', 'USING', 'SET', 'LIMIT', 'UNION', 'NATURAL', 'HAVING', 'FETCH', 'WINDOW']);

/** FROM / JOIN references of the text before the cursor: name parts + alias (`FROM a x, b y` gives both). */
export function tableRefsBefore(text: string): Array<{ parts: string[]; alias: string | null }> {
  const re = new RegExp(String.raw`\b(FROM|JOIN|UPDATE|INTO)\s+(${QNAME})(?:\s+(?:AS\s+)?(${IDENT}))?`, 'gi');
  const next = new RegExp(String.raw`\s*,\s*(${QNAME})(?:\s+(?:AS\s+)?(${IDENT}))?`, 'y');
  const out: Array<{ parts: string[]; alias: string | null }> = [];
  const add = (name: string, alias: string | undefined) => {
    out.push({ parts: partsOf(name), alias: alias && !NOT_ALIAS.has(alias.toUpperCase()) ? unquote(alias) : null });
  };
  for (const m of text.matchAll(re)) {
    add(m[2]!, m[3]);
    if (m[1]!.toUpperCase() !== 'FROM' || (m[3] && NOT_ALIAS.has(m[3].toUpperCase()))) continue;
    next.lastIndex = m.index! + m[0].length;
    for (let n = next.exec(text); n; n = next.exec(text)) {
      add(n[1]!, n[2]);
      if (n[2] && NOT_ALIAS.has(n[2].toUpperCase())) break;
    }
  }
  return out;
}

/** Resolves name parts (table | schema.table | catalog.schema.table) against the loaded table lists of a store. */
export function resolveTable(store: SchemaStore, parts: string[], defaultSchema?: string | null): TableRef | null {
  const eq = (a: string, b: string) => a === b || a.toUpperCase() === b.toUpperCase();
  const name = parts[parts.length - 1]!;
  const schema = parts.length >= 2 ? parts[parts.length - 2]! : null;
  const catalog = parts.length >= 3 ? parts[0]! : null;
  const cands: TableRef[] = [];
  for (const { catalog: c, schema: s, tables } of store.loadedTables()) {
    if (catalog && !(c && eq(c, catalog))) continue;
    if (schema && !eq(s, schema)) continue;
    for (const t of tables) if (eq(t.name, name)) cands.push({ catalog: c, schema: s, name: t.name });
  }
  if (cands.length <= 1 || schema) return cands[0] ?? null;
  return cands.find((c) => defaultSchema && eq(c.schema, defaultSchema)) ?? cands[0]!;
}

const ieq = (a: string, b: string) => a === b || a.toUpperCase() === b.toUpperCase();
const findName = (list: readonly string[] | undefined, name: string) => list?.find((x) => x === name) ?? list?.find((x) => ieq(x, name));
const restart = (ctx: CompletionContext, loads: Array<Promise<unknown>>) => {
  if (loads.length) void Promise.all(loads).then(() => { if (ctx.view?.hasFocus) startCompletion(ctx.view); });
};

/** Text of the statement around the cursor (split on `;`, good enough for completion) and the cursor offset in it. */
function statementAround(ctx: CompletionContext): { text: string; pos: number } {
  const from = Math.max(0, ctx.pos - 20_000);
  const before = ctx.state.doc.sliceString(from, ctx.pos);
  const after = ctx.state.doc.sliceString(ctx.pos, Math.min(ctx.state.doc.length, ctx.pos + 20_000));
  const head = before.slice(before.lastIndexOf(';') + 1);
  const semi = after.indexOf(';');
  return { text: head + (semi < 0 ? after : after.slice(0, semi)), pos: head.length };
}

/** `name.` / `a.b.` / `a.b.c.` right before the cursor (plus the word being typed after the dot). */
const QUALIFIED = new RegExp(String.raw`(${QNAME})\s*\.\s*[\w$#]*$`);
export const isQualified = (ctx: CompletionContext) => !!ctx.matchBefore(QUALIFIED);

/**
 * Everything after a dot — `db.` → schemas, `db.schema.` / `schema.` → tables, `[db.][schema.]table.` / `alias.` →
 * columns — matched case-insensitively against the store, loading what is missing on the way (the list reopens once it
 * is there). Also preloads what unqualified completion needs: the catalogs/databases, the schemas (single catalog), the
 * tables of the default schema and the columns of the tables in FROM / JOIN of the current statement.
 */
export function lazyMetaSource(store: () => SchemaStore | null, defaultSchema: () => string | null | undefined, driver?: () => DriverType | undefined): CompletionSource {
  return (ctx) => {
    const st = store();
    if (!st) return null;
    const loads: Array<Promise<unknown>> = [];
    const ensureSchemas = (c: string | undefined) => { if (!st.schemas(c)) loads.push(st.loadSchemas(c)); };
    const ensureTables = (c: string | undefined, s: string) => { if (!st.tables(c, s)) loads.push(st.loadTables(c, s)); };
    const ensureColumns = (r: TableRef | null) => { if (r && !st.columns(r)) loads.push(st.loadColumns(r)); };

    if (!st.catalogs()) loads.push(st.loadCatalogs());
    const cats = st.catalogs()?.value;
    // one database (PostgreSQL) or none (Oracle): its schemas are what unqualified names live in
    const single = cats && cats.length <= 1 ? (cats[0] ?? null) : undefined;
    const ds = defaultSchema();
    if (single !== undefined) {
      ensureSchemas(single ?? undefined);
      if (ds) ensureTables(single ?? undefined, ds);
    }
    const catalogKeys = (): Array<string | undefined> => (cats?.length ? cats : [undefined]);
    // the schema `name` is in: in the single catalog, or any catalog whose schemas are loaded
    const schemaHome = (name: string): { catalog: string | undefined; schema: string } | null => {
      for (const c of catalogKeys()) {
        const s = findName(st.schemas(c)?.value, name);
        if (s) return { catalog: c, schema: s };
      }
      return null;
    };
    // `parts` names a table ([db.][schema.]table): the lists leading to it, then its columns
    const ensureTable = (parts: string[]): TableRef | null => {
      if (parts.length === 3) {
        const c = findName(cats, parts[0]!);
        if (c === undefined) return null;
        const s = findName(st.schemas(c)?.value, parts[1]!);
        if (!s) { ensureSchemas(c); return null; }
        ensureTables(c, s);
      } else if (parts.length === 2) {
        const h = schemaHome(parts[0]!);
        if (h) ensureTables(h.catalog, h.schema);
      }
      const r = resolveTable(st, parts, ds);
      ensureColumns(r);
      return r;
    };

    const refs = tableRefsBefore(statementAround(ctx).text);
    for (const r of refs) ensureTable(r.parts);

    const m = ctx.matchBefore(QUALIFIED);
    if (!m) { restart(ctx, loads); return null; }
    // the qualifier without the word typed after the dot
    const parts = partsOf(m.text.replace(/\s*\.\s*[\w$#]*$/, ''));
    const d = driver?.() ?? 'postgresql';
    const options: Completion[] = [];
    const seen = new Set<string>();
    const add = (label: string, type: string, detail?: string) => {
      const k = `${type}\u0001${label}`;
      if (seen.has(k)) return;
      seen.add(k);
      const q = quoteIdent(label, d);
      options.push({ label, type, ...(detail ? { detail } : {}), ...(q !== label ? { apply: q } : {}), boost: 5 });
    };
    const addTables = (c: string | undefined, s: string) => { for (const t of st.tables(c, s)?.value ?? []) add(t.name, 'class', t.type?.toLowerCase()); };
    const addColumns = (r: TableRef | null) => { for (const col of (r && st.columns(r)?.value?.columns) || []) add(col.name, 'property', col.typeName); };

    const byAlias = parts.length === 1 ? refs.find((r) => r.alias && ieq(r.alias, parts[0]!)) : undefined;
    if (byAlias) addColumns(ensureTable(byAlias.parts));
    else {
      // database. / database.schema.
      const c = parts.length <= 2 ? findName(cats, parts[0]!) : undefined;
      if (c !== undefined && parts.length === 1) { ensureSchemas(c); for (const s of st.schemas(c)?.value ?? []) add(s, 'namespace', 'schema'); }
      if (c !== undefined && parts.length === 2) {
        const s = findName(st.schemas(c)?.value, parts[1]!);
        if (s) { ensureTables(c, s); addTables(c, s); } else ensureSchemas(c);
      }
      // schema.
      if (parts.length === 1) { const h = schemaHome(parts[0]!); if (h) { ensureTables(h.catalog, h.schema); addTables(h.catalog, h.schema); } }
      // [db.][schema.]table.
      addColumns(ensureTable(parts));
    }
    restart(ctx, loads);
    if (options.length === 0) return null;
    return { from: ctx.pos - /[\w$#]*$/.exec(m.text)![0].length, options, validFor: /^[\w$#]*$/ };
  };
}

const TABLE_POS = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:[\w$#"]+\s*\.\s*){0,2}[\w$#"]*$/i;

/**
 * Bare column names of the tables in FROM / JOIN of the current statement (also before the FROM: `SELECT | FROM t`),
 * from loaded columns only; `t.col`/`alias.col` stay with schemaCompletionSource.
 */
export function statementColumnsSource(store: () => SchemaStore | null, defaultSchema: () => string | null | undefined): CompletionSource {
  return (ctx) => {
    const st = store();
    const word = ctx.matchBefore(/[\w$#]*$/);
    if (!st || !word || (word.from === word.to && !ctx.explicit)) return null;
    const lineBefore = ctx.state.doc.sliceString(Math.max(0, word.from - 1000), word.from);
    if (/\.\s*$/.test(lineBefore) || TABLE_POS.test(lineBefore + word.text)) return null;
    const refs = tableRefsBefore(statementAround(ctx).text);
    const byName = new Map<string, Completion>();
    for (const r of refs) {
      const t = resolveTable(st, r.parts, defaultSchema());
      const cols = t && st.columns(t)?.value?.columns;
      for (const c of cols ?? []) {
        const owner = r.alias ?? t!.name;
        const cur = byName.get(c.name);
        if (cur) { if (!cur.detail!.split(', ').includes(owner)) cur.detail += `, ${owner}`; continue; }
        byName.set(c.name, { label: c.name, type: 'property', detail: owner, info: c.typeName, boost: 2 });
      }
    }
    if (byName.size === 0) return null;
    return { from: word.from, options: [...byName.values()], validFor: /^[\w$#]*$/ };
  };
}

/** After `JOIN t [alias] ON `: join conditions from foreign keys between t and the tables already in the statement. */
export function joinConditionSource(store: () => SchemaStore | null, driver: () => DriverType | undefined, defaultSchema: () => string | null | undefined): CompletionSource {
  return (ctx) => {
    const st = store();
    if (!st) return null;
    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 20_000), ctx.pos);
    const m = new RegExp(String.raw`\bJOIN\s+(${QNAME})(?:\s+(?:AS\s+)?(${IDENT}))?\s+ON\s+([\w]*)$`, 'i').exec(before);
    if (!m) return null;
    const d = driver() ?? 'postgresql';
    const refs = tableRefsBefore(before.slice(0, m.index));
    const joinedParts = partsOf(m[1]!);
    const joinedAlias = m[2] && !NOT_ALIAS.has(m[2].toUpperCase()) ? unquote(m[2]) : null;
    const joined = resolveTable(st, joinedParts, defaultSchema());
    if (!joined) return null;
    const q = (s: string) => quoteIdent(s, d);
    const nameOf = (r: TableRef, alias: string | null) => (alias ? q(alias) : q(r.name));
    const options: Completion[] = [];
    const jc = st.columns(joined)?.value;
    if (!st.columns(joined)) void st.loadColumns(joined);
    for (const other of refs) {
      const o = resolveTable(st, other.parts, defaultSchema());
      if (!o) continue;
      const oc = st.columns(o)?.value;
      if (!st.columns(o)) void st.loadColumns(o);
      const add = (fkCols: string[], fkOwner: string, refCols: string[], refOwner: string) => {
        const label = fkCols.map((c, i) => `${fkOwner}.${q(c)} = ${refOwner}.${q(refCols[i] ?? c)}`).join(' AND ');
        if (!options.some((x) => x.label === label)) options.push({ label, type: 'keyword', detail: 'FK', boost: 10 });
      };
      // joined table references the other one, or the other way round
      for (const fk of jc?.foreignKeys ?? []) if (fk.refTable.toUpperCase() === o.name.toUpperCase()) add(fk.columns, nameOf(joined, joinedAlias), fk.refColumns, nameOf(o, other.alias));
      for (const fk of oc?.foreignKeys ?? []) if (fk.refTable.toUpperCase() === joined.name.toUpperCase()) add(fk.columns, nameOf(o, other.alias), fk.refColumns, nameOf(joined, joinedAlias));
    }
    if (options.length === 0) return null;
    return { from: ctx.pos - m[3]!.length, options, validFor: /^\w*$/ };
  };
}

/** `namespace` may be a getter (read on every completion, so metadata loaded meanwhile shows up at once). */
export function completionSources(dialect: SQLDialect, namespace: SQLNamespace | (() => SQLNamespace), extra: CompletionSource[], defaultSchema?: () => string | null | undefined): CompletionSource[] {
  let cache: { ns: SQLNamespace; ds: string | undefined; src: CompletionSource } | undefined;
  const schemaSource: CompletionSource = (ctx) => {
    const ns = typeof namespace === 'function' ? namespace() : namespace;
    const ds = defaultSchema?.() ?? undefined;
    if (!cache || cache.ns !== ns || cache.ds !== ds) cache = { ns, ds, src: schemaCompletionSource({ dialect, schema: ns, ...(ds ? { defaultSchema: ds } : {}) }) };
    return cache.src(ctx);
  };
  const keywords = keywordCompletionSource(dialect, true);
  return [
    ...extra,
    // after a dot only object names make sense; those come from lazyMetaSource (case-insensitive, loads on demand)
    (ctx) => (isQualified(ctx) ? null : schemaSource(ctx)),
    (ctx) => (isQualified(ctx) ? null : keywords(ctx)),
    (ctx) => (isQualified(ctx) ? null : snippetSource(ctx)),
  ];
}
