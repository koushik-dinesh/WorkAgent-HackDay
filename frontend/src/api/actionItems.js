import { api } from './client.js';

export const updateActionItem = (id, body) => api(`/action-items/${id}`, { method: 'PATCH', body });
export const approveActionItem = (id) => api(`/action-items/${id}/approve`, { method: 'POST' });
export const rejectActionItem = (id, reason) =>
  api(`/action-items/${id}/reject`, { method: 'POST', body: reason ? { reason } : {} });
export const reopenActionItem = (id) => api(`/action-items/${id}/reopen`, { method: 'POST' });
export const setActionItemProject = (id, projectId) => api(`/action-items/${id}/project`, { method: 'PUT', body: { projectId } });

// Creating approved items as Jira issues (admin).
export const listExportTargets = () => api('/action-items/export-targets');
export const listMeetingExports = (meetingId) => api(`/action-items/exports?meetingId=${encodeURIComponent(meetingId)}`);
export const requestActionItemExport = (id, resourceId) => api(`/action-items/${id}/exports`, { method: 'POST', body: { resourceId } });
