import defaults from '../../../../../services/api/internal/config/agent-defaults.json';
import type { LlmMapping } from './harness/llm';
export type HarnessConfig = typeof defaults.runtime.harness;
export type MemoryConfig = typeof defaults.runtime.memory;
export type OpenMetadataConfig = typeof defaults.runtime.openMetadata;
export interface AgentRuntimeConfig {
 llm: LlmMapping & { timeoutSec: number };
 harness: HarnessConfig;
 http: typeof defaults.runtime.http;
 openMetadata: OpenMetadataConfig;
 memory: MemoryConfig;
}
/** Canonical server defaults for standalone helpers/tests. Production receives a config snapshot per run. */
export const DEFAULT_RUNTIME: AgentRuntimeConfig = defaults.runtime;
