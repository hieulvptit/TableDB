import { describe, expect, it, vi } from 'vitest';
import { CompletionStream } from './stream';
import { LlmProvider } from './llm';
import type { AgentHttp } from './bridge';

const event = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\r\n\r\n`;
const end = 'data: [DONE]\r\n\r\n';
const endpoint = { id: 'gw', label: 'GW', baseUrl: 'https://gateway.example/v1', models: ['m'] };

describe('LLM streaming', () => {
  it('handles fragmented SSE events, comments, CRLF and Vietnamese text', () => {
    const live = vi.fn();
    const parser = new CompletionStream(live);
    const wire = ': keepalive\r\n\r\n' + event('Xin ') + event('chào 👋') + end;
    for (let i = 0; i < wire.length; i += 3) parser.push(wire.slice(i, i + 3));
    expect(parser.finish()).toBe('Xin chào 👋');
    expect(live.mock.calls).toEqual([['Xin '], ['Xin chào 👋']]);
  });

  it('rejects interrupted, malformed, upstream-error and output-limited streams', () => {
    const interrupted = new CompletionStream(); interrupted.push(event('partial'));
    expect(() => interrupted.finish()).toThrow('interrupted');
    expect(() => new CompletionStream().push('data: nope\n\n')).toThrow('invalid');
    expect(() => new CompletionStream().push('data: {"error":{"message":"failed"}}\n\n')).toThrow('failed');
    expect(() => new CompletionStream().push('data: {"choices":[{"index":0,"finish_reason":"length"}]}\n\n')).toThrow('output limit');
  });

  it('delivers partial text before resolving and reconciles missing IPC events with the full body', async () => {
    const live = vi.fn();
    const http: AgentHttp = async (req, _signal, onChunk) => {
      expect(JSON.parse(req.body!).stream).toBe(true);
      onChunk?.(event('Xin '));
      expect(live).toHaveBeenCalledWith('Xin ');
      return { status: 200, contentType: 'text/event-stream', body: event('Xin ') + event('chào') + end };
    };
    expect(await new LlmProvider(http).chat(endpoint, 'm', [{ role: 'user', content: 'hello' }], undefined, live)).toBe('Xin chào');
    expect(live).toHaveBeenLastCalledWith('Xin chào');
  });

  it('accepts JSON replies from gateways that ignore stream and keeps background requests non-streaming', async () => {
    const http: AgentHttp = async (req, _signal, onChunk) => {
      expect(JSON.parse(req.body!).stream).toBeUndefined();
      expect(onChunk).toBeUndefined();
      return { status: 200, contentType: 'application/json', body: '{"choices":[{"message":{"content":"summary"}}]}' };
    };
    expect(await new LlmProvider(http).chat(endpoint, 'm', [{ role: 'user', content: 'summarize' }])).toBe('summary');
    const json: AgentHttp = async () => ({ status: 200, contentType: 'application/json', body: '{"choices":[{"message":{"content":"answer"}}]}' });
    expect(await new LlmProvider(json).chat(endpoint, 'm', [{ role: 'user', content: 'hello' }], undefined, vi.fn())).toBe('answer');
  });
});
