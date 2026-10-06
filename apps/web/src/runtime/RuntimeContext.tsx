import { createContext, useContext } from 'react';

export interface RuntimeInfo { env: string; desktop: boolean; version?: string; apiBase: string; apiConnectionMode?: 'direct' | 'proxy' }
export const RuntimeContext = createContext<RuntimeInfo>({ env: 'dev', desktop: false, apiBase: '/api/v1' });
export const useRuntime = () => useContext(RuntimeContext);
