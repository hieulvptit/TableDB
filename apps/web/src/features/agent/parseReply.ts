export type ReplySegment = { type: 'text'; text: string } | { type: 'code'; lang: string; code: string };

/** Split an assistant reply into text and fenced code segments. Everything is rendered as plain text (no HTML). */
export function parseReply(reply: string): ReplySegment[] {
  const out: ReplySegment[] = [];
  const re = /```([A-Za-z0-9_+-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(reply); m; m = re.exec(reply)) {
    if (m.index > last) out.push({ type: 'text', text: reply.slice(last, m.index) });
    out.push({ type: 'code', lang: (m[1] ?? '').toLowerCase(), code: (m[2] ?? '').replace(/\s+$/, '') });
    last = m.index + m[0].length;
  }
  if (last < reply.length) out.push({ type: 'text', text: reply.slice(last) });
  return out.filter((s) => (s.type === 'code' ? s.code.trim().length > 0 : s.text.trim().length > 0));
}
