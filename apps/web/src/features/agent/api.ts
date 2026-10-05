import type { AgentChatBody } from '@vnpay/shared';
import { desktopCommands } from '../../runtime/tauri';
import type { AgentChatResult, AgentSettings, AgentTokenState, AgentTraceEvent, OpenMetadataTokenState } from '../../api/types';
import { agentAuditReporter } from '../tabledb/audit';
import type { PreviewBody } from './context';
import { AgentService } from './service';

let svc: AgentService | null = null;
/** The Agent runs in this app: no /agent/* server calls (only the metadata-only audit record is sent). */
const service = () => (svc ??= new AgentService({
  config: () => desktopCommands.agentConfig(),
  secrets: { get: desktopCommands.secretGet, set: desktopCommands.secretSet, delete: desktopCommands.secretDelete },
  audit: (body) => agentAuditReporter.reportRaw(body),
}));
/** Tests install a service with fakes. */
export function setAgentService(s: AgentService | null) { svc = s; }

export const agentApi = {
  settings: (): Promise<AgentSettings> => service().settings(),
  tokenState: (): Promise<AgentTokenState> => service().tokenState(),
  saveToken: (b: { token: string; endpointId: string; model: string }) => service().saveToken(b),
  verify: () => service().verify(),
  deleteToken: () => service().deleteToken(),
  omState: (): Promise<OpenMetadataTokenState> => service().omState(),
  saveOmToken: (token: string) => service().saveOmToken(token),
  deleteOmToken: () => service().deleteOmToken(),
  preview: (b: PreviewBody, _signal?: AbortSignal) => service().preview(b),
  chat: (b: AgentChatBody, signal?: AbortSignal): Promise<AgentChatResult> => service().chat(b, undefined, signal),
  /** Streams live steps (`onTrace`) and resolves with the final result. */
  chatStream: (b: AgentChatBody, onTrace: (e: AgentTraceEvent) => void, signal?: AbortSignal): Promise<AgentChatResult> => service().chat(b, onTrace, signal),
};
