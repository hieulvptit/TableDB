// SQL statement classifier. Conservative: anything unknown is "other" (never treated as read).
// The Java sidecar re-implements the same rules; both are tested against testdata/sql-classify.json.

export type SqlKind = 'read' | 'write' | 'ddl' | 'other';
export interface SqlClassification {
  kind: SqlKind;
  /** more than one statement — executors must reject */
  multi: boolean;
  firstKeyword: string;
}

interface Scanned {
  statements: string[][]; // uppercase word tokens per statement (outside strings/comments)
}

function isWordStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isWordPart(c: string): boolean {
  return /[A-Za-z0-9_$#]/.test(c);
}

const CREATE_MODIFIERS = new Set(['OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'EDITIONING', 'NO', 'FORCE']);
const isWord = (t: string | undefined) => !!t && t !== "'" && t !== '"ID"';

/**
 * Stored PL/SQL unit whose body has inner semicolons: CREATE [OR REPLACE] [EDITIONABLE] PACKAGE [BODY] / TYPE BODY always,
 * PROCEDURE / FUNCTION / TRIGGER when the body is PL (IS/AS followed by a word, or BEGIN/DECLARE) rather than a
 * dollar-quoted string (PostgreSQL). Mirrors SqlClassifier.isPlUnit (Java).
 */
export function isPlUnit(tokens: string[]): boolean {
  if (tokens[0] !== 'CREATE') return false;
  let i = 1;
  while (i < tokens.length && CREATE_MODIFIERS.has(tokens[i]!)) i++;
  const obj = tokens[i];
  if (obj === 'PACKAGE') return true;
  if (obj === 'TYPE') return tokens[i + 1] === 'BODY';
  if (obj !== 'PROCEDURE' && obj !== 'FUNCTION' && obj !== 'TRIGGER') return false;
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t === 'BEGIN' || t === 'DECLARE') return true;
    if ((t === 'IS' || t === 'AS') && isWord(tokens[k + 1])) return true;
  }
  return false;
}

function scan(sql: string): Scanned {
  const statements: string[][] = [];
  let cur: string[] = [];
  let depthWords = 0;
  const n = sql.length;
  let i = 0;
  const push = () => {
    if (cur.length > 0) statements.push(cur);
    cur = [];
  };
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; } else i++;
      }
      cur.push("'"); // placeholder so an empty-looking statement isn't dropped
    } else if (c === '"' || c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) { i++; break; } else i++;
      }
      cur.push('"ID"');
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        cur.push("'");
      } else i++;
    } else if (c === ';') {
      // PL/SQL style blocks: the whole thing is one unit
      const first = cur[0];
      if (first === 'BEGIN' || first === 'DECLARE') { i++; continue; }
      if (statements.length === 0 && isPlUnit(cur)) { i++; continue; }
      push();
      i++;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j]!)) j++;
      cur.push(sql.slice(i, j).toUpperCase());
      i = j;
    } else {
      if (c === '(') depthWords++;
      i++;
    }
  }
  void depthWords;
  push();
  return { statements };
}

const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const DDL = new Set(['TRUNCATE', 'CREATE', 'DROP', 'ALTER', 'GRANT', 'REVOKE', 'COMMENT', 'RENAME']);
const STARTS = new Set(['SELECT', 'WITH', 'VALUES', ...DML, ...DDL]);

function classifyTokens(tokens: string[]): SqlKind {
  const first = tokens[0];
  if (!first) return 'other';
  if (DML.has(first)) return 'write';
  if (DDL.has(first)) return 'ddl';
  if (first === 'SHOW' || first === 'DESCRIBE' || first === 'DESC' || first === 'VALUES') return 'read';
  if (first === 'EXPLAIN') {
    const idx = tokens.findIndex((t, k) => k > 0 && STARTS.has(t));
    return idx < 0 ? 'read' : classifyTokens(tokens.slice(idx));
  }
  if (first === 'SELECT' || first === 'WITH') {
    if (first === 'WITH' && tokens.some((t) => DML.has(t))) return 'write';
    if (tokens.includes('INTO')) return 'write';
    for (let k = 0; k < tokens.length - 1; k++) {
      if (tokens[k] === 'FOR' && tokens[k + 1] === 'UPDATE') return 'write';
    }
    if (first === 'WITH' && !tokens.includes('SELECT') && !tokens.includes('VALUES')) return 'other';
    return 'read';
  }
  return 'other';
}

export function classifySql(sql: string): SqlClassification {
  const { statements } = scan(sql);
  const multi = statements.length > 1;
  const first = statements[0] ?? [];
  return { kind: multi ? 'other' : classifyTokens(first), multi, firstKeyword: first[0] ?? '' };
}

/** Classification of a possibly-multi input where the kind reflects the most dangerous statement. */
export function classifyKindOfAll(sql: string): SqlKind {
  const { statements } = scan(sql);
  const order: SqlKind[] = ['read', 'write', 'ddl', 'other'];
  let worst = 0;
  for (const s of statements) worst = Math.max(worst, order.indexOf(classifyTokens(s)));
  return statements.length === 0 ? 'other' : order[worst]!;
}
