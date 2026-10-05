/**
 * Client-side guard for a query tab bound to one database (catalog): a statement may not name objects of another
 * database (`otherdb.schema.table`) nor switch the session to it (`USE otherdb`). Schemas of the bound database are
 * all allowed (`public` ↔ `callcfg`). Best effort on top of the sidecar's own checks.
 */
const IDENT = /[A-Za-z_][A-Za-z0-9_$#]*/y;

interface Scanned { chains: string[][]; text: string }

/** Identifier chains (`a.b.c`) outside strings/comments, plus the SQL with comments removed. */
function scanSql(sql: string): Scanned {
  const chains: string[][] = [];
  let text = '';
  let cur: string[] | null = null;
  let afterDot = false;
  const flush = () => { if (cur && cur.length > 1) chains.push(cur); cur = null; afterDot = false; };
  const add = (name: string) => { if (cur && afterDot) cur.push(name); else { flush(); cur = [name]; } afterDot = false; };
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (two === '--') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; text += ' '; continue; }
    if (two === '/*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; text += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
      const body = sql.slice(i + 1, j).replace(new RegExp(c + c, 'g'), c);
      text += sql.slice(i, j + 1);
      i = j + 1;
      if (c === "'") flush(); else add(body);
      continue;
    }
    if (c === '.') { afterDot = !!cur; text += c; i++; continue; }
    IDENT.lastIndex = i;
    const m = IDENT.exec(sql);
    if (m) { add(m[0]); text += m[0]; i += m[0].length; continue; }
    if (!/\s/.test(c)) flush();
    text += c; i++;
  }
  flush();
  return { chains, text };
}

const unq = (s: string) => s.replace(/^["'`\[]|["'`\]]$|;$/g, '').replace(/;$/, '').trim();

const USE_DB = /^\s*USE\s+(?:DATABASE\s+|CATALOG\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$#]+)/i;

/**
 * Name of the foreign database the statement reaches into, or null when it stays in `bound`.
 * `databases` = every database (catalog) the connection lists; `schemas` = schemas of the bound database
 * (a name that is both a schema here and another database is read as the schema).
 */
export function findCrossDatabase(sql: string, bound: string | null | undefined, databases: Iterable<string>, schemas: Iterable<string> = []): string | null {
  if (!bound) return null;
  const local = new Set([bound, ...schemas].map((x) => x.toLowerCase()));
  const foreign = new Set([...databases].map((x) => x.toLowerCase()).filter((x) => !local.has(x)));
  if (!foreign.size) return null;
  const { chains, text } = scanSql(sql);
  const use = USE_DB.exec(text);
  if (use) { const v = unq(use[1]!); if (foreign.has(v.toLowerCase())) return v; }
  for (const ch of chains) {
    for (const part of ch.slice(0, Math.min(2, ch.length - 1))) if (foreign.has(part.toLowerCase())) return part;
  }
  return null;
}
