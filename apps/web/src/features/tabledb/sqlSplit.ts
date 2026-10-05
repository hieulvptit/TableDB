import { isPlUnit, type DriverType } from '@vnpay/shared';

/** One statement of an editor buffer: [from, to) are offsets into the buffer; `text` is what gets executed. */
export interface Stmt { from: number; to: number; text: string }

type TokType = 'word' | 'str' | 'punct' | 'semi' | 'slash' | 'blank';
interface Tok { type: TokType; value: string; start: number; end: number }

/**
 * Lexer for statement splitting: comments are skipped, strings / quoted identifiers / PostgreSQL dollar quotes / Oracle
 * q'[..]' are single tokens. `slash` = a line holding only "/" (SQL*Plus block terminator), `blank` = an empty line.
 */
function lex(sql: string): Tok[] {
  const out: Tok[] = [];
  const n = sql.length;
  let i = 0;
  let lineHasContent = false;
  const push = (type: TokType, start: number, end: number) => { out.push({ type, value: type === 'word' ? sql.slice(start, end).toUpperCase() : sql.slice(start, end), start, end }); lineHasContent = true; };
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    if (c === '\n') {
      // an empty line (only whitespace since the previous newline)
      if (!lineHasContent) out.push({ type: 'blank', value: '', start: i, end: i + 1 });
      lineHasContent = false;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; lineHasContent = true; continue; }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      lineHasContent = true;
      continue;
    }
    if (c === '/' && !lineHasContent) {
      let j = i + 1;
      while (j < n && (sql[j] === ' ' || sql[j] === '\t' || sql[j] === '\r')) j++;
      if (j >= n || sql[j] === '\n') { out.push({ type: 'slash', value: '/', start: i, end: i + 1 }); i = j; lineHasContent = true; continue; }
    }
    if (c === "'") {
      const backslash = i > 0 && /[eE]/.test(sql[i - 1]!) && (i < 2 || !/[A-Za-z0-9_$#]/.test(sql[i - 2]!));
      const s = i;
      i++;
      while (i < n) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      push('str', s, Math.min(i, n));
      continue;
    }
    if (c === '"' || c === '`') {
      const s = i;
      i++;
      while (i < n) {
        if (sql[i] === c && sql[i + 1] === c) { i += 2; continue; }
        if (sql[i] === c) { i++; break; }
        i++;
      }
      push('str', s, Math.min(i, n));
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const s = i;
        i = end < 0 ? n : end + m[0].length;
        push('str', s, i);
        continue;
      }
      push('punct', i, i + 1);
      i++;
      continue;
    }
    if (c === ';') { push('semi', i, i + 1); i++; continue; }
    if (/[A-Za-z_À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$#À-￿]/.test(sql[j]!)) j++;
      const w = sql.slice(i, j);
      // Oracle alternative quoting q'[...]' / nq'[...]'
      if (/^n?q$/i.test(w) && sql[j] === "'" && j + 1 < n) {
        const open = sql[j + 1]!;
        const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
        const end = sql.indexOf(`${close}'`, j + 2);
        if (!/\s/.test(open) && end >= 0) { push('str', i, end + 2); i = end + 2; continue; }
      }
      push('word', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(sql[j]!)) j++;
      push('punct', i, j);
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}

/** first keywords that start a new statement after a blank line ("smart" blank-line delimiter, like DBeaver) */
const STARTERS = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE',
  'COMMENT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'EXEC', 'EXECUTE', 'BEGIN', 'DECLARE', 'VALUES', 'SET', 'USE', 'ANALYZE', 'VACUUM', 'COMMIT', 'ROLLBACK', 'RENAME', 'LOCK']);
/** a statement cannot end right after these (the next line continues it) */
const CONTINUES = new Set(['UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'MINUS', 'AND', 'OR', 'NOT', 'ON', 'WHERE', 'FROM', 'JOIN', 'BY', 'SELECT', 'SET', 'AS', 'IN',
  'THEN', 'ELSE', 'WHEN', 'CASE', 'VALUES', 'INTO', 'HAVING', 'LIKE', 'IS', 'BETWEEN', 'WITH', 'DISTINCT', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'USING']);

/** BEGIN/END nesting of a PL block: openers are BEGIN, CASE, IF, LOOP (and IS/AS of a package or type body). */
function blockDelta(toks: Tok[], k: number, unitHead: string | null, headIsUsed: { v: boolean }): number {
  const w = toks[k]!.value;
  const next = toks[k + 1]?.type === 'word' ? toks[k + 1]!.value : '';
  const prev = k > 0 && toks[k - 1]!.type === 'word' ? toks[k - 1]!.value : '';
  if (w === 'END') return -1;
  if ((w === 'IF' || w === 'LOOP' || w === 'CASE') && prev === 'END') return 0; // END IF / END LOOP / END CASE
  if (w === 'BEGIN' || w === 'CASE' || w === 'LOOP') return 1;
  if (w === 'IF' && next !== 'EXISTS') return 1; // CREATE ... IF NOT EXISTS is not a block
  if ((w === 'IS' || w === 'AS') && (unitHead === 'PACKAGE' || unitHead === 'TYPE') && !headIsUsed.v) { headIsUsed.v = true; return 1; }
  return 0;
}

/** CREATE [OR REPLACE] [EDITIONABLE] <object>: the object keyword (PACKAGE, TYPE, PROCEDURE, …) */
function unitObject(words: string[]): string | null {
  if (words[0] !== 'CREATE') return null;
  let i = 1;
  while (['OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING', 'NO', 'FORCE'].includes(words[i] ?? '')) i++;
  return words[i] ?? null;
}

/**
 * Splits an editor buffer into statements: top-level `;`, a line holding only `/`, and a blank line followed by a
 * statement keyword (unless the previous line clearly continues). Oracle anonymous blocks (BEGIN/DECLARE) and stored
 * PL units (CREATE PROCEDURE … END;) are kept whole including the final `;`, which PL/SQL needs.
 */
export function splitStatements(sql: string, driver?: DriverType): Stmt[] {
  const toks = lex(sql);
  const out: Stmt[] = [];
  let cur: Tok[] = [];
  let depthParen = 0;
  let block: { depth: number; opened: boolean; head: string | null; used: { v: boolean } } | null = null;
  const emit = (endTok?: Tok, includeEnd = false) => {
    const sig = cur.filter((t) => t.type !== 'blank');
    if (sig.length > 0) {
      const first = sig[0]!;
      // the statement starts at its first token — or at a comment right before it on the same run of lines
      const from = leadingStart(sql, first.start, out.length ? out[out.length - 1]!.to : 0);
      const to = includeEnd && endTok ? endTok.end : sig[sig.length - 1]!.end;
      out.push({ from, to, text: sql.slice(from, to) });
    }
    cur = [];
    depthParen = 0;
    block = null;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.type === 'slash') { emit(); continue; }
    const words = cur.filter((x) => x.type === 'word').map((x) => x.value);
    if (!block && t.type === 'word' && cur.every((x) => x.type === 'blank')) {
      if (driver !== 'postgresql' && driver !== 'trino' && (t.value === 'BEGIN' || t.value === 'DECLARE')) block = { depth: 0, opened: false, head: null, used: { v: false } };
    }
    if (t.type === 'blank') {
      if (!block && depthParen === 0 && words.length > 0) {
        const nextSig = toks.slice(k + 1).find((x) => x.type !== 'blank');
        const last = [...cur].reverse().find((x) => x.type !== 'blank');
        const continues = !last || (last.type === 'word' && CONTINUES.has(last.value)) || (last.type === 'punct' && /^[,(=<>+\-*/|.]$/.test(last.value));
        if (nextSig && nextSig.type === 'word' && STARTERS.has(nextSig.value) && !continues) { emit(); continue; }
      }
      cur.push(t);
      continue;
    }
    if (t.type === 'punct') { if (t.value === '(') depthParen++; else if (t.value === ')') depthParen = Math.max(0, depthParen - 1); }
    if (t.type === 'semi') {
      if (!block) {
        // the shared classifier's token shape: words upper-case, strings "'", quoted identifiers '"ID"'
        const shape = cur.filter((x) => x.type === 'word' || x.type === 'str').map((x) => (x.type === 'word' ? x.value : /^["`]/.test(x.value) ? '"ID"' : "'"));
        if (isPlUnit(shape)) {
          // stored PL unit: re-scan its tokens for nesting and keep going
          const head = unitObject(words);
          block = { depth: 0, opened: false, head, used: { v: false } };
          for (let j = 0; j < cur.length; j++) if (cur[j]!.type === 'word') { const dl = blockDelta(cur, j, head, block.used); if (dl > 0) block.opened = true; block.depth += dl; }
          if (block.opened && block.depth <= 0) { cur.push(t); emit(t, true); continue; }
          cur.push(t);
          continue;
        }
        emit();
        continue;
      }
      cur.push(t);
      if (block.opened && block.depth <= 0) emit(t, true);
      continue;
    }
    cur.push(t);
    if (block && t.type === 'word') {
      const dl = blockDelta(cur, cur.length - 1, block.head, block.used);
      if (dl > 0) block.opened = true;
      block.depth += dl;
    }
  }
  emit();
  return out;
}

/** Start of a statement including comment lines written directly above it (but not past the previous statement). */
function leadingStart(sql: string, tokStart: number, floor: number): number {
  let from = tokStart;
  let lineStart = sql.lastIndexOf('\n', from - 1) + 1;
  // only whitespace between line start and token: look at the lines above for `--` comments
  if (sql.slice(lineStart, from).trim() !== '') return from;
  for (;;) {
    if (lineStart <= floor) break;
    const prevEnd = lineStart - 1;
    const prevStart = sql.lastIndexOf('\n', prevEnd - 1) + 1;
    const line = sql.slice(prevStart, prevEnd).trim();
    if (!line.startsWith('--') || prevStart < floor) break;
    from = prevStart + (sql.slice(prevStart, prevEnd).length - sql.slice(prevStart, prevEnd).trimStart().length);
    lineStart = prevStart;
  }
  return from;
}

/** Statement containing `pos` (or the nearest one before it; after the last one: the last). */
export function statementAt(stmts: Stmt[], pos: number): Stmt | null {
  if (stmts.length === 0) return null;
  for (const s of stmts) if (pos >= s.from && pos <= s.to) return s;
  let best: Stmt | null = null;
  for (const s of stmts) if (s.to <= pos) best = s;
  return best ?? stmts[0]!;
}

// ------------------------------------------------------------------ named bind parameters

export interface BindScan { sql: string; names: string[] }

/**
 * `:name` placeholders outside strings/comments → `?` (JDBC positional), with the names in order (a name used twice
 * appears twice). Not a placeholder: `::type` casts, `:=`, `a[1:2]`, and anything glued to a preceding identifier.
 */
export function findBinds(sql: string): BindScan {
  const toks = lex(sql);
  const names: string[] = [];
  let out = '';
  let last = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.type !== 'punct' || t.value !== ':') continue;
    const w = toks[k + 1];
    if (!w || w.type !== 'word' || w.start !== t.end) continue;
    const before = t.start > 0 ? sql[t.start - 1]! : ' ';
    if (!/[\s(,=<>+\-*/|!]/.test(before)) continue;
    names.push(sql.slice(w.start, w.end));
    out += `${sql.slice(last, t.start)}?`;
    last = w.end;
  }
  return { sql: out + sql.slice(last), names };
}

// ------------------------------------------------------------------ error position

/** Where the database says the error is, relative to the executed statement: 0-based offset. */
export function errorOffset(message: string, stmt: string): number | null {
  const pg = /Position: (\d+)/.exec(message);
  if (pg) { const o = Number(pg[1]) - 1; return o >= 0 && o <= stmt.length ? o : null; }
  const lc = /\bline (\d+)[:,]\s*(?:col(?:umn)?\s*)?(\d+)/i.exec(message) ?? /Line: (\d+) Column: (\d+)/.exec(message);
  if (lc) {
    const line = Number(lc[1]), col = Number(lc[2]);
    const lines = stmt.split('\n');
    if (line < 1 || line > lines.length) return null;
    let o = 0;
    for (let i = 0; i < line - 1; i++) o += lines[i]!.length + 1;
    return Math.min(o + Math.max(0, col - 1), stmt.length);
  }
  return null;
}
