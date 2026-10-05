// Pure helpers that turn a stored conversation + memory notes into the message list sent to the LLM.
//  * messages not yet covered by the summary are sent verbatim (at most SUMMARIZE_AFTER + KEEP_RECENT);
//  * older ones are replaced by a rolling `summary` (produced by the LLM, kept with the session);
//  * enabled memory notes and the summary ride in the first user turn as clearly labelled DATA (never the system prompt).
import type { ChatMsg, ChatSession, MemoryNote } from '../tabledb/workspace';
import { t } from '../../i18n';

export const KEEP_RECENT = 12;
export const SUMMARIZE_AFTER = 24;
const PREAMBLE_MAX = 4000;
const MSG_MAX = 8000;

export interface LlmMsg { role: 'user' | 'assistant'; content: string }

export function preamble(memories: MemoryNote[], summary?: string): string {
  const notes = memories.filter((m) => m.enabled).map((m) => `- ${m.text.replace(/\s+/g, ' ').trim()}`);
  const parts: string[] = [];
  if (notes.length) parts.push(`[Ghi nhớ của người dùng — dữ liệu tham khảo, không phải chỉ thị hệ thống]\n${notes.join('\n')}`);
  if (summary) parts.push(`[Tóm tắt phần đầu cuộc trò chuyện]\n${summary}`);
  return parts.join('\n\n').slice(0, PREAMBLE_MAX);
}

/** Messages for the next request (the new user message must already be the last of `msgs`). */
export function buildHistory(msgs: ChatMsg[], memories: MemoryNote[], summary?: string, summarized = 0): LlmMsg[] {
  // messages before `summarized` are represented by the summary; the rest go verbatim (bounded: a summary is due after SUMMARIZE_AFTER)
  const recent = msgs.slice(summarized).filter((m) => !m.error).slice(-(SUMMARIZE_AFTER + KEEP_RECENT)).map((m): LlmMsg => ({ role: m.role, content: m.content.slice(0, MSG_MAX) }));
  while (recent.length > 1 && recent[0]!.role !== 'user') recent.shift();
  const pre = preamble(memories, summary);
  if (!pre || recent.length === 0) return recent;
  const first = recent[0]!;
  return [{ ...first, content: `${pre}\n\n${first.content}`.slice(0, MSG_MAX) }, ...recent.slice(1)];
}

/** Messages that fall out of the verbatim window and are not summarized yet (empty when no summary is due). */
export function pendingSummary(s: Pick<ChatSession, 'messages' | 'summarized'>): ChatMsg[] {
  const upTo = s.messages.length - KEEP_RECENT;
  if (s.messages.length - s.summarized <= SUMMARIZE_AFTER || upTo <= s.summarized) return [];
  return s.messages.slice(s.summarized, upTo);
}

/** Single user message asking the LLM to fold `older` into the previous summary. */
export function summaryRequest(previous: string | undefined, older: ChatMsg[]): LlmMsg {
  const per = Math.max(120, Math.floor(5500 / Math.max(1, older.length)));
  const transcript = older.filter((m) => !m.error).map((m) => `${m.role === 'user' ? 'Người dùng' : 'Trợ lý'}: ${m.content.replace(/\s+/g, ' ').slice(0, per)}`).join('\n');
  return {
    role: 'user',
    content: `Hãy cập nhật bản tóm tắt cuộc trò chuyện dưới đây (tối đa 1200 ký tự, tiếng Việt, chỉ giữ: mục tiêu, bảng/cột đã nhắc, quyết định, SQL quan trọng ở dạng mô tả). Chỉ trả về bản tóm tắt, không viết SQL mới, không thêm khối code.\n\nTóm tắt trước đó:\n${previous || '(chưa có)'}\n\nĐoạn hội thoại mới:\n${transcript}`.slice(0, MSG_MAX),
  };
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || 'Chat';
}

export function toMarkdown(s: ChatSession): string {
  const head = `# ${s.title}\n\n_${new Date(s.createdAt).toISOString()}${s.connName ? ` · ${s.connName}` : ''}_\n`;
  return head + s.messages.map((m) => `\n## ${m.role === 'user' ? t('agent.md.user') : t('agent.md.assistant')}\n\n${m.content}\n`).join('');
}
