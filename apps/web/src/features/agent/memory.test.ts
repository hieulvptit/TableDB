import { describe, expect, it } from 'vitest';
import type { ChatMsg, MemoryNote } from '../tabledb/workspace';
import { buildHistory, KEEP_RECENT, pendingSummary, preamble, summaryRequest, titleFrom, SUMMARIZE_AFTER } from './memory';

const mk = (n: number): ChatMsg[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, at: i }));
const note = (text: string, enabled = true): MemoryNote => ({ id: text, text, at: 0, enabled });

describe('buildHistory', () => {
  it('sends only the messages after the summarized prefix, starting on a user turn', () => {
    const h = buildHistory(mk(31), [], 'sum', 19);
    expect(h.length).toBeLessThanOrEqual(KEEP_RECENT);
    expect(h[0]!.role).toBe('user');
    expect(h[h.length - 1]!.content).toBe('m30');
  });
  it('puts enabled memory + summary in the first user turn as labelled data; disabled notes are left out', () => {
    const h = buildHistory(mk(3), [note('Dùng schema PAY'), note('bí mật', false)], 'Đã bàn về orders');
    expect(h[0]!.content).toContain('Dùng schema PAY');
    expect(h[0]!.content).toContain('Đã bàn về orders');
    expect(h[0]!.content).not.toContain('bí mật');
    expect(h[0]!.content.endsWith('m0')).toBe(true);
    expect(h[1]!.content).toBe('m1');
  });
  it('skips failed turns and leaves messages untouched without memory', () => {
    const m = mk(3); m[1] = { ...m[1]!, error: true };
    expect(buildHistory(m, [], undefined).map((x) => x.content)).toEqual(['m0', 'm2']);
  });
});

describe('summaries', () => {
  it('is due only after SUMMARIZE_AFTER unsummarized messages and covers all but the recent window', () => {
    expect(pendingSummary({ messages: mk(SUMMARIZE_AFTER), summarized: 0 })).toEqual([]);
    const s = { messages: mk(SUMMARIZE_AFTER + 1), summarized: 0 };
    expect(pendingSummary(s)).toHaveLength(SUMMARIZE_AFTER + 1 - KEEP_RECENT);
    expect(pendingSummary({ ...s, summarized: s.messages.length - KEEP_RECENT })).toEqual([]);
  });
  it('request embeds the previous summary and stays within the message limit', () => {
    const r = summaryRequest('cũ', mk(40).map((m) => ({ ...m, content: 'x'.repeat(2000) })));
    expect(r.content).toContain('cũ');
    expect(r.content.length).toBeLessThanOrEqual(8000);
  });
});

describe('misc', () => {
  it('preamble is capped; title is trimmed', () => {
    expect(preamble([note('a'.repeat(500)), ...Array.from({ length: 20 }, (_, i) => note('b'.repeat(400) + i))]).length).toBeLessThanOrEqual(4000);
    expect(titleFrom('  hello   world ')).toBe('hello world');
    expect(titleFrom('x'.repeat(100)).length).toBe(48);
  });
});
