import type { DriverType } from '@vnpay/shared';
import { formatCell } from '@vnpay/ui';
import { runAudited } from './exec';
import { quoteIdent } from './tableSql';
import type { Connection } from './types';

/** Schema objects other than tables/views, read with read-only catalog queries of the user's own session. */
export type ObjectKind = 'procedures' | 'functions' | 'packages' | 'sequences' | 'synonyms' | 'triggers' | 'mviews' | 'types';
export interface DbObject { name: string; kind: ObjectKind; status?: string; detail?: string; /** engine id (PostgreSQL oid) used to read the source */ oid?: string; table?: string }

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function objectKinds(driver: DriverType): ObjectKind[] {
  if (driver === 'oracle') return ['procedures', 'functions', 'packages', 'sequences', 'synonyms', 'triggers', 'mviews', 'types'];
  if (driver === 'postgresql') return ['functions', 'procedures', 'sequences', 'triggers', 'types'];
  return [];
}

function listSql(driver: DriverType, kind: ObjectKind, schema: string): string | null {
  const s = lit(schema);
  if (driver === 'oracle') {
    const byType = (t: string) => `SELECT OBJECT_NAME AS NAME, STATUS, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI') AS DETAIL FROM ALL_OBJECTS WHERE OWNER = ${s} AND OBJECT_TYPE = '${t}' ORDER BY OBJECT_NAME`;
    switch (kind) {
      case 'procedures': return byType('PROCEDURE');
      case 'functions': return byType('FUNCTION');
      case 'packages': return byType('PACKAGE');
      case 'types': return byType('TYPE');
      case 'sequences': return `SELECT SEQUENCE_NAME AS NAME, NULL AS STATUS, 'last ' || LAST_NUMBER || ', +' || INCREMENT_BY AS DETAIL FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = ${s} ORDER BY SEQUENCE_NAME`;
      case 'synonyms': return `SELECT SYNONYM_NAME AS NAME, NULL AS STATUS, TABLE_OWNER || '.' || TABLE_NAME || CASE WHEN DB_LINK IS NOT NULL THEN '@' || DB_LINK END AS DETAIL FROM ALL_SYNONYMS WHERE OWNER = ${s} ORDER BY SYNONYM_NAME`;
      case 'triggers': return `SELECT TRIGGER_NAME AS NAME, STATUS, TRIGGERING_EVENT || ' ON ' || TABLE_NAME AS DETAIL, TABLE_NAME FROM ALL_TRIGGERS WHERE OWNER = ${s} ORDER BY TRIGGER_NAME`;
      case 'mviews': return `SELECT MVIEW_NAME AS NAME, STALENESS AS STATUS, TO_CHAR(LAST_REFRESH_DATE, 'YYYY-MM-DD HH24:MI') AS DETAIL FROM ALL_MVIEWS WHERE OWNER = ${s} ORDER BY MVIEW_NAME`;
    }
  }
  if (driver === 'postgresql') {
    const proc = (k: string) => `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name, NULL AS status, l.lanname || CASE WHEN p.prokind = 'f' THEN ' → ' || pg_get_function_result(p.oid) ELSE '' END AS detail, p.oid::text AS oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = ${s} AND p.prokind = '${k}' ORDER BY 1`;
    switch (kind) {
      case 'functions': return proc('f');
      case 'procedures': return proc('p');
      case 'sequences': return `SELECT c.relname AS name, NULL AS status, NULL AS detail, c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${s} AND c.relkind = 'S' ORDER BY 1`;
      case 'triggers': return `SELECT t.tgname AS name, CASE t.tgenabled WHEN 'D' THEN 'DISABLED' ELSE 'ENABLED' END AS status, 'ON ' || c.relname AS detail, t.oid::text AS oid, c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${s} AND NOT t.tgisinternal ORDER BY 1`;
      case 'types': return `SELECT t.typname AS name, NULL AS status, CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite' WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range' ELSE t.typtype::text END AS detail, t.oid::text AS oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${s} AND t.typtype IN ('e', 'c', 'd', 'r') AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')) ORDER BY 1`;
      default: return null;
    }
  }
  return null;
}

export async function listObjects(conn: Connection, schema: string, kind: ObjectKind): Promise<DbObject[]> {
  const sql = listSql(conn.driver, kind, schema);
  if (!sql) return [];
  const g = await runAudited(conn, sql, 'read', { maxRows: 5000, all: true });
  const col = (n: string) => g.columns.findIndex((c) => c.toUpperCase() === n);
  const [ni, si, di, oi, ti] = [col('NAME'), col('STATUS'), col('DETAIL'), col('OID'), col('TABLE_NAME')];
  const str = (r: unknown[], i: number) => (i >= 0 && r[i] !== null && r[i] !== undefined ? formatCell(r[i]).text : undefined);
  return g.rows.map((r) => ({ name: str(r, ni) ?? '', kind, ...(str(r, si) ? { status: str(r, si) } : {}), ...(str(r, di) ? { detail: str(r, di) } : {}), ...(str(r, oi) ? { oid: str(r, oi) } : {}), ...(str(r, ti) ? { table: str(r, ti) } : {}) }));
}

const ORACLE_META_TYPE: Partial<Record<ObjectKind, string>> = { procedures: 'PROCEDURE', functions: 'FUNCTION', packages: 'PACKAGE', sequences: 'SEQUENCE', synonyms: 'SYNONYM', triggers: 'TRIGGER', mviews: 'MATERIALIZED_VIEW', types: 'TYPE' };
const ORACLE_SOURCE_TYPE: Partial<Record<ObjectKind, string[]>> = { procedures: ['PROCEDURE'], functions: ['FUNCTION'], packages: ['PACKAGE', 'PACKAGE BODY'], triggers: ['TRIGGER'], types: ['TYPE', 'TYPE BODY'] };

const firstText = (g: { rows: unknown[][] }) => g.rows.map((r) => (r[0] === null || r[0] === undefined ? '' : formatCell(r[0]).text)).join('');

/** Source / DDL of an object: DBMS_METADATA, then ALL_SOURCE (Oracle); pg_get_functiondef / pg_get_triggerdef (PostgreSQL). */
export async function objectSource(conn: Connection, schema: string, o: DbObject): Promise<string> {
  const d = conn.driver;
  if (d === 'oracle') {
    const mt = ORACLE_META_TYPE[o.kind];
    if (mt) {
      try {
        const g = await runAudited(conn, `SELECT DBMS_METADATA.GET_DDL('${mt}', ${lit(o.name)}, ${lit(schema)}) FROM DUAL`, 'read', { maxRows: 1 });
        const text = firstText(g).trim();
        if (text) return `${text}\n`;
      } catch { /* no EXECUTE on DBMS_METADATA / no SELECT_CATALOG_ROLE: fall back to ALL_SOURCE */ }
    }
    const types = ORACLE_SOURCE_TYPE[o.kind];
    if (types) {
      const parts: string[] = [];
      for (const ty of types) {
        const g = await runAudited(conn, `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ${lit(schema)} AND NAME = ${lit(o.name)} AND TYPE = '${ty}' ORDER BY LINE`, 'read', { maxRows: 100_000, all: true });
        const body = firstText(g);
        if (body.trim()) parts.push(`CREATE OR REPLACE ${body.trimEnd()}\n/`);
      }
      if (parts.length) return `${parts.join('\n\n')}\n`;
    }
    if (o.kind === 'synonyms' && o.detail) return `CREATE SYNONYM ${quoteIdent(schema, d)}.${quoteIdent(o.name, d)} FOR ${o.detail};\n`;
    throw new Error('source not available');
  }
  if (d === 'postgresql') {
    const oid = o.oid && /^\d+$/.test(o.oid) ? o.oid : null;
    if (!oid) throw new Error('source not available');
    if (o.kind === 'functions' || o.kind === 'procedures') return `${firstText(await runAudited(conn, `SELECT pg_get_functiondef(${oid}::oid)`, 'read', { maxRows: 1 })).trimEnd()};\n`;
    if (o.kind === 'triggers') return `${firstText(await runAudited(conn, `SELECT pg_get_triggerdef(${oid}::oid, true)`, 'read', { maxRows: 1 }))};\n`;
    if (o.kind === 'sequences') {
      const g = await runAudited(conn, `SELECT 'CREATE SEQUENCE ' || quote_ident(schemaname) || '.' || quote_ident(sequencename) || ' AS ' || data_type || ' INCREMENT BY ' || increment_by || ' MINVALUE ' || min_value || ' MAXVALUE ' || max_value || ' START WITH ' || start_value || ' CACHE ' || cache_size || CASE WHEN cycle THEN ' CYCLE' ELSE '' END || '; -- last_value: ' || COALESCE(last_value::text, 'null') FROM pg_sequences WHERE schemaname = ${lit(schema)} AND sequencename = ${lit(o.name)}`, 'read', { maxRows: 1 });
      return `${firstText(g)}\n`;
    }
    if (o.kind === 'types') {
      const g = await runAudited(conn, `SELECT CASE t.typtype WHEN 'e' THEN 'CREATE TYPE ' || ${lit(`${quoteIdent(schema, d)}.${quoteIdent(o.name, d)}`)} || ' AS ENUM (' || (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) || ');' WHEN 'd' THEN 'CREATE DOMAIN ' || ${lit(`${quoteIdent(schema, d)}.${quoteIdent(o.name, d)}`)} || ' AS ' || format_type(t.typbasetype, t.typtypmod) || ';' WHEN 'c' THEN 'CREATE TYPE ' || ${lit(`${quoteIdent(schema, d)}.${quoteIdent(o.name, d)}`)} || ' AS (' || (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) || ');' ELSE '-- ' || t.typname END FROM pg_type t WHERE t.oid = ${oid}::oid`, 'read', { maxRows: 1 });
      return `${firstText(g)}\n`;
    }
  }
  throw new Error('source not available');
}

/** A call skeleton for a routine (inserted into the editor; never run automatically). */
export function callTemplate(driver: DriverType, schema: string, o: DbObject): string {
  const q = (s: string) => quoteIdent(s, driver);
  if (driver === 'oracle') {
    if (o.kind === 'functions') return `SELECT ${q(schema)}.${q(o.name)}(/* args */) FROM DUAL`;
    if (o.kind === 'procedures') return `BEGIN\n  ${q(schema)}.${q(o.name)}(/* args */);\nEND;`;
    if (o.kind === 'sequences') return `SELECT ${q(schema)}.${q(o.name)}.NEXTVAL FROM DUAL`;
    return `SELECT * FROM ${q(schema)}.${q(o.name)}`;
  }
  const base = o.name.replace(/\(.*$/, '');
  if (o.kind === 'functions') return `SELECT ${q(schema)}.${q(base)}(/* args */)`;
  if (o.kind === 'procedures') return `CALL ${q(schema)}.${q(base)}(/* args */)`;
  if (o.kind === 'sequences') return `SELECT nextval('${schema.replace(/'/g, "''")}.${o.name.replace(/'/g, "''")}')`;
  return `-- ${o.name}`;
}
