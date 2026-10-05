import { apiClient } from './client';
import { asList } from './services';
import type { Delegation } from './types';

/** BO portal only: approvals, delegations, approver change. */
export const approvalsApi = {
  decision: (id: string, b: { decision: 'approve' | 'reject'; reason?: string }) => apiClient.post(`/transfers/${encodeURIComponent(id)}/decision`, b),
  changeApprover: (id: string, approverId: string) => apiClient.post(`/transfers/${encodeURIComponent(id)}/change-approver`, { approverId }),
  delegations: async () => asList<Delegation>(await apiClient.get<unknown>('/delegations'), 'delegations'),
  createDelegation: (b: { toUserId: string; validFrom: string; validTo: string }) => apiClient.post('/delegations', b),
  deleteDelegation: (id: string) => apiClient.del(`/delegations/${encodeURIComponent(id)}`),
};
