import { ApiError } from '../../../api/errors';

/** Incremental OpenAI-compatible SSE parser. HTTP chunks may split any event. */
export class CompletionStream {
  private pending = '';
  private text = '';
  private done = false;
  constructor(private onText?: (text: string) => void) {}

  push(chunk: string): void {
    this.pending += chunk;
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) return;
      const event = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { this.done = true; continue; }
      let doc: { error?: unknown; choices?: Array<{ index?: number; delta?: { content?: unknown }; finish_reason?: string | null }> };
      try { doc = JSON.parse(data); }
      catch { throw new ApiError('UPSTREAM', 'invalid LLM stream event', 502); }
      if (!doc || doc.error) throw new ApiError('UPSTREAM', 'LLM stream failed', 502);
      const choice = doc.choices?.find((c) => c.index === 0 || c.index === undefined);
      if (typeof choice?.delta?.content === 'string') {
        this.text += choice.delta.content;
        this.onText?.(this.text);
      }
      if (choice?.finish_reason === 'length') throw new ApiError('UPSTREAM', 'LLM answer exceeded output limit', 502);
      if (choice?.finish_reason) this.done = true;
    }
  }

  finish(): string {
    if (this.pending.trim()) this.push('\n\n');
    if (!this.done) throw new ApiError('UPSTREAM', 'LLM stream interrupted', 502);
    return this.text;
  }
}
