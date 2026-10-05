import type { DriverType } from '@vnpay/shared';
import { formatCell } from '@vnpay/ui';
import type { TableRef } from './schemaStore';

export function quoteIdent(name: string, driver: DriverType): string {
  const simple = driver === 'oracle' ? /^[A-Z_][A-Z0-9_$#]*$/ : /^[a-z_][a-z0-9_$]*$/;
  return simple.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
export const qualified = (r: TableRef, driver: DriverType) =>
  `${driver === 'trino' && r.catalog ? `${quoteIdent(r.catalog, driver)}.` : ''}${quoteIdent(r.schema, driver)}.${quoteIdent(r.name, driver)}`;
export function selectStarSql(r: TableRef, driver: DriverType): string {
  const q = qualified(r, driver);
  return driver === 'oracle' ? `SELECT * FROM ${q}\nFETCH FIRST 100 ROWS ONLY` : `SELECT * FROM ${q}\nLIMIT 100`;
}

/** Data view of a table: no LIMIT — rows are paged from the server cursor as the user scrolls (bounded by maxRows). */
export function tableDataSql(r: TableRef, driver: DriverType, filter?: string, orderBy?: { column: string; desc: boolean } | null): string {
  const where = filter?.replace(/[\s;]+$/, '').trim();
  const order = orderBy ? `\nORDER BY ${quoteIdent(orderBy.column, driver)}${orderBy.desc ? ' DESC' : ''}` : '';
  return `SELECT * FROM ${qualified(r, driver)}${where ? `\nWHERE ${where}` : ''}${order}`;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type MetaKind = 'indexes' | 'partitions' | 'properties';

/** Read-only catalog query for one table (null = the engine has no such concept, e.g. Trino has no indexes). */
export function metaSql(kind: MetaKind, r: TableRef, driver: DriverType): string | null {
  const s = lit(r.schema), n = lit(r.name);
  if (driver === 'oracle') {
    if (kind === 'indexes') return `SELECT i.INDEX_NAME, i.INDEX_TYPE, i.UNIQUENESS, (SELECT LISTAGG(c.COLUMN_NAME || CASE WHEN c.DESCEND = 'DESC' THEN ' DESC' END, ', ') WITHIN GROUP (ORDER BY c.COLUMN_POSITION) FROM ALL_IND_COLUMNS c WHERE c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME) AS COLUMNS, i.STATUS, i.PARTITIONED, i.TABLESPACE_NAME, i.LAST_ANALYZED FROM ALL_INDEXES i WHERE i.TABLE_OWNER = ${s} AND i.TABLE_NAME = ${n} ORDER BY i.INDEX_NAME`;
    // HIGH_VALUE is a LONG column: it must be the last one selected
    if (kind === 'partitions') return `SELECT PARTITION_POSITION, PARTITION_NAME, TABLESPACE_NAME, NUM_ROWS, LAST_ANALYZED, HIGH_VALUE FROM ALL_TAB_PARTITIONS WHERE TABLE_OWNER = ${s} AND TABLE_NAME = ${n} ORDER BY PARTITION_POSITION`;
    return `SELECT OWNER, TABLESPACE_NAME, NUM_ROWS, BLOCKS, AVG_ROW_LEN, LAST_ANALYZED, PARTITIONED, TEMPORARY, COMPRESSION, LOGGING, DEGREE FROM ALL_TABLES WHERE OWNER = ${s} AND TABLE_NAME = ${n}`;
  }
  if (driver === 'trino') {
    const q = qualified(r, driver);
    if (kind === 'indexes') return null;
    if (kind === 'partitions') return `SELECT * FROM ${r.catalog ? `${quoteIdent(r.catalog, driver)}.` : ''}${quoteIdent(r.schema, driver)}."${r.name.replace(/"/g, '""')}$partitions"`;
    return `SHOW STATS FOR ${q}`;
  }
  if (kind === 'indexes') return `SELECT c.relname AS index_name, am.amname AS type, i.indisunique AS "unique", i.indisprimary AS "primary", pg_get_indexdef(i.indexrelid) AS definition, pg_size_pretty(pg_relation_size(i.indexrelid)) AS size FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace JOIN pg_am am ON am.oid = c.relam WHERE ns.nspname = ${s} AND t.relname = ${n} ORDER BY c.relname`;
  if (kind === 'partitions') return `SELECT child.relname AS partition_name, pg_get_expr(child.relpartbound, child.oid) AS bounds, pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size, child.reltuples::bigint AS est_rows FROM pg_inherits inh JOIN pg_class parent ON parent.oid = inh.inhparent JOIN pg_namespace pn ON pn.oid = parent.relnamespace JOIN pg_class child ON child.oid = inh.inhrelid WHERE pn.nspname = ${s} AND parent.relname = ${n} ORDER BY child.relname`;
  return `SELECT pg_get_userbyid(c.relowner) AS owner, c.relkind AS kind, c.reltuples::bigint AS est_rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, pg_size_pretty(pg_relation_size(c.oid)) AS table_size, pg_size_pretty(pg_indexes_size(c.oid)) AS index_size, c.relispartitioned AS partitioned, c.relpersistence AS persistence, obj_description(c.oid) AS comment FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${s} AND c.relname = ${n}`;
}

// ---------------------------------------------------------------- export
export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';
export const EXPORT_EXT: Record<ExportFormat, { ext: string; mime: string }> = {
  csv: { ext: 'csv', mime: 'text/csv;charset=utf-8' }, xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, json: { ext: 'json', mime: 'application/json;charset=utf-8' }, sql: { ext: 'sql', mime: 'text/plain;charset=utf-8' },
};

const NUMERIC_TYPE = /int|num|dec|float|double|real|serial|money/i;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const TEMPORAL = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?/;

/** SQL literal for a value of a column of the given type (shared by the INSERT export and the import). */
export function sqlLiteral(v: unknown, typeName: string, driver: DriverType): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return driver === 'oracle' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
  const text = typeof v === 'string' ? v : formatCell(v).text;
  if (typeof v === 'string' && NUMERIC_TYPE.test(typeName) && NUMBER.test(v.trim())) return v.trim();
  if (typeof v === 'string' && TEMPORAL.test(v)) {
    const isTs = /timestamp|datetime/i.test(typeName) || (driver === 'oracle' && /date/i.test(typeName) && v.length > 10);
    const isDate = /date/i.test(typeName);
    if (isTs || isDate) {
      const body = v.replace('T', ' ').replace(/Z$/, '').replace(/([+-]\d{2}:?\d{2})$/, '');
      if (driver === 'oracle') return /timestamp/i.test(typeName) ? `TIMESTAMP ${lit(body)}` : `TO_DATE(${lit(body.slice(0, 19))}, 'YYYY-MM-DD HH24:MI:SS')`;
      if (driver === 'trino') return isTs ? `TIMESTAMP ${lit(body)}` : `DATE ${lit(body.slice(0, 10))}`;
    }
  }
  return lit(text);
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))), null, 2);
}

/** Batches of multi-row INSERTs (Oracle: INSERT ALL … SELECT 1 FROM DUAL, which is what a single statement can carry there). */
export function insertStatements(ref: TableRef, driver: DriverType, columns: Array<{ name: string; typeName: string }>, rows: unknown[][], batch = 200): string[] {
  const q = qualified(ref, driver);
  const cols = columns.map((c) => quoteIdent(c.name, driver)).join(', ');
  const tuple = (r: unknown[]) => `(${columns.map((c, i) => sqlLiteral(r[i], c.typeName, driver)).join(', ')})`;
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    out.push(driver === 'oracle'
      ? `INSERT ALL\n${part.map((r) => `  INTO ${q} (${cols}) VALUES ${tuple(r)}`).join('\n')}\nSELECT 1 FROM DUAL`
      : `INSERT INTO ${q} (${cols}) VALUES\n${part.map((r) => `  ${tuple(r)}`).join(',\n')}`);
  }
  return out;
}
export const toSqlScript = (ref: TableRef, driver: DriverType, columns: Array<{ name: string; typeName: string }>, rows: unknown[][]) =>
  insertStatements(ref, driver, columns, rows).map((s) => `${s};`).join('\n\n');

// ---------------------------------------------------------------- row edits (table data view)
export interface ColType { name: string; typeName: string }

/** `pk = lit AND …` identifying one row by its primary key (NULL key parts compare with IS NULL). */
function pkWhere(columns: ColType[], pk: number[], row: unknown[], driver: DriverType): string {
  return pk.map((i) => {
    const c = columns[i]!;
    const v = row[i];
    return v === null || v === undefined ? `${quoteIdent(c.name, driver)} IS NULL` : `${quoteIdent(c.name, driver)} = ${sqlLiteral(v, c.typeName, driver)}`;
  }).join(' AND ');
}

export function updateRowSql(ref: TableRef, driver: DriverType, columns: ColType[], pk: number[], original: unknown[], changes: Map<number, unknown>): string {
  const set = [...changes.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => `${quoteIdent(columns[i]!.name, driver)} = ${sqlLiteral(v, columns[i]!.typeName, driver)}`).join(', ');
  return `UPDATE ${qualified(ref, driver)} SET ${set} WHERE ${pkWhere(columns, pk, original, driver)}`;
}
export function deleteRowSql(ref: TableRef, driver: DriverType, columns: ColType[], pk: number[], original: unknown[]): string {
  return `DELETE FROM ${qualified(ref, driver)} WHERE ${pkWhere(columns, pk, original, driver)}`;
}
/** Columns left `undefined` are omitted (the database default applies). */
export function insertRowSql(ref: TableRef, driver: DriverType, columns: ColType[], row: unknown[]): string {
  const used = columns.map((c, i) => ({ c, i })).filter(({ i }) => row[i] !== undefined);
  if (used.length === 0) return driver === 'oracle' ? `INSERT INTO ${qualified(ref, driver)} (${quoteIdent(columns[0]!.name, driver)}) VALUES (DEFAULT)` : `INSERT INTO ${qualified(ref, driver)} DEFAULT VALUES`;
  return `INSERT INTO ${qualified(ref, driver)} (${used.map(({ c }) => quoteIdent(c.name, driver)).join(', ')}) VALUES (${used.map(({ c, i }) => sqlLiteral(row[i], c.typeName, driver)).join(', ')})`;
}

/**
 * Insert-or-update batches keyed on `keyCols` (names): PostgreSQL `INSERT … ON CONFLICT (…) DO UPDATE`, Oracle
 * `MERGE … USING (SELECT … FROM DUAL UNION ALL …)`. Other engines: null (not offered).
 */
export function upsertStatements(ref: TableRef, driver: DriverType, columns: ColType[], keyCols: string[], rows: unknown[][], batch = 200): string[] | null {
  if (driver !== 'postgresql' && driver !== 'oracle') return null;
  const q = qualified(ref, driver);
  const id = (n: string) => quoteIdent(n, driver);
  const keys = new Set(keyCols);
  const rest = columns.filter((c) => !keys.has(c.name));
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    if (driver === 'postgresql') {
      const tuples = part.map((r) => `  (${columns.map((c, k) => sqlLiteral(r[k], c.typeName, driver)).join(', ')})`).join(',\n');
      const action = rest.length ? `DO UPDATE SET ${rest.map((c) => `${id(c.name)} = EXCLUDED.${id(c.name)}`).join(', ')}` : 'DO NOTHING';
      out.push(`INSERT INTO ${q} (${columns.map((c) => id(c.name)).join(', ')}) VALUES\n${tuples}\nON CONFLICT (${keyCols.map(id).join(', ')}) ${action}`);
    } else {
      const src = part.map((r) => `SELECT ${columns.map((c, k) => `${sqlLiteral(r[k], c.typeName, driver)} AS ${id(c.name)}`).join(', ')} FROM DUAL`).join('\n  UNION ALL ');
      const on = keyCols.map((k) => `d.${id(k)} = s.${id(k)}`).join(' AND ');
      const upd = rest.length ? `\nWHEN MATCHED THEN UPDATE SET ${rest.map((c) => `d.${id(c.name)} = s.${id(c.name)}`).join(', ')}` : '';
      out.push(`MERGE INTO ${q} d\nUSING (\n  ${src}\n) s\nON (${on})${upd}\nWHEN NOT MATCHED THEN INSERT (${columns.map((c) => id(c.name)).join(', ')}) VALUES (${columns.map((c) => `s.${id(c.name)}`).join(', ')})`);
    }
  }
  return out;
}
