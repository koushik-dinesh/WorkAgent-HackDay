// Action Center, execution engine and follow-up settings (backend routes/actions.js).
import { api } from './client.js';

const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const listActions = (params = {}) => api(`/actions${qs(params)}`);
export const actionSummary = () => api('/actions/summary');
export const getAction = (id) => api(`/actions/${id}`);
export const editAction = (id, body) => api(`/actions/${id}`, { method: 'PATCH', body });
export const reviewAction = (id, action, body = {}) => api(`/actions/${id}/${action}`, { method: 'POST', body });
export const setActionStatus = (id, status) => api(`/actions/${id}/status`, { method: 'POST', body: { status } });

export const executionCapabilities = () => api('/actions/execution/capabilities');
export const preparePlan = (body) => api('/actions/execution/plans', { method: 'POST', body });
export const listPlans = (params = {}) => api(`/actions/execution/plans${qs(params)}`);
export const getPlan = (id) => api(`/actions/execution/plans/${id}`);
export const approvePlan = (id, previewHash, largeConfirmed = false) => api(`/actions/execution/plans/${id}/approve`, { method: 'POST', body: { previewHash, largeConfirmed } });
export const cancelPlan = (id) => api(`/actions/execution/plans/${id}/cancel`, { method: 'POST' });
export const rejectPlan = (id, reason) => api(`/actions/execution/plans/${id}/reject`, { method: 'POST', body: reason ? { reason } : {} });
export const retryExecution = (id) => api(`/actions/execution/executions/${id}/retry`, { method: 'POST' });

export const actionSettings = () => api('/actions/settings');
export const saveFollowups = (body) => api('/actions/settings/followups', { method: 'PUT', body });
export const saveSourceSettings = (body) => api('/actions/settings/sources', { method: 'PUT', body });
export const scanSourcesNow = () => api('/actions/settings/sources/scan', { method: 'POST' });
