// Masking used before anything is written to audit/log. Best effort; never rely on it to make data "safe to send".

const SENSITIVE_KEYS = /^(pass(word)?|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie|credential|access_token|refresh_token|id_token|client_secret)$/i;

/** Replace string/number literals with `?` (keeps structure, drops data). */
export function maskSql(sql: string): string {
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; } else i++;
      }
      out += '?';
    } else if (/[0-9]/.test(c) && !/[A-Za-z0-9_$#.]/.test(sql[i - 1] ?? ' ')) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j]!)) j++;
      out += '?';
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED:card]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED:email]'],
  [/(?<![\d])(?:\+?84|0)(?:[ .-]?\d){9,10}(?!\d)/g, '[REDACTED:phone]'],
  [/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactObject<T>(v: T, depth = 0): T {
  if (depth > 8) return '[DEPTH]' as unknown as T;
  if (typeof v === 'string') return redactText(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactObject(x, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redactObject(val, depth + 1);
    }
    return o as T;
  }
  return v;
}
