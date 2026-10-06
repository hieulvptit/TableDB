// The only network path of the Agent: the Rust core performs the HTTP calls (LLM gateway, OpenMetadata MCP). Rust resolves
// the base URL from the validated server allow-list and attaches the credential from the OS credential store, so the
// webview never needs a CSP hole and never has to hold a stored token.
import { ApiError } from '../../../api/errors';
import { desktopCommands, tauriChannel } from '../../../runtime/tauri';

export type AgentTarget = { kind: 'llm'; endpointId: string } | { kind: 'om' };
export interface AgentHttpRequest {
  target: AgentTarget;
  method: string;
  /** appended to the endpoint base URL */
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutSec?: number;
  /** use this credential instead of the stored one (verifying a token before it is saved) */
  token?: string;
}
export interface AgentHttpResponse { status: number; contentType: string; sessionId?: string; body: string }
export type AgentHttp = (req: AgentHttpRequest, signal?: AbortSignal, onChunk?: (text: string) => void) => Promise<AgentHttpResponse>;

let seq = 0;
/** Production transport. Aborting the signal cancels the in-flight request in Rust. */
export const tauriAgentHttp: AgentHttp = async (req, signal, onChunk) => {
  if (signal?.aborted) throw new Error('cancelled');
  const requestId = `ah-${Date.now().toString(36)}-${++seq}`;
  const onAbort = () => { void desktopCommands.agentHttpCancel(requestId).catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let channel: ReturnType<typeof tauriChannel> | undefined;
  const decoder = new TextDecoder();
  try {
    if (onChunk) channel = tauriChannel<number[]>((bytes) => {
      if (!signal?.aborted) onChunk(decoder.decode(new Uint8Array(bytes), { stream: true }));
    });
    if (signal?.aborted) throw new Error('cancelled');
    const result = await desktopCommands.agentHttp(requestId, { ...req, stream: !!onChunk }, channel?.id);
    if (signal?.aborted) throw new Error('cancelled');
    if (onChunk) { const tail = decoder.decode(); if (tail) onChunk(tail); }
    return result;
  }
  catch (e) {
    if (signal?.aborted) throw new Error('cancelled');
    const x = e as { code?: string; message?: string };
    if (x?.code === 'E_AGENT_NO_TOKEN') throw new ApiError('VALIDATION', 'no LLM token configured', 400);
    throw new ApiError('UPSTREAM', typeof x?.message === 'string' && x.message ? x.message : 'endpoint unreachable', 502);
  }
  finally { channel?.close(); signal?.removeEventListener('abort', onAbort); }
};
