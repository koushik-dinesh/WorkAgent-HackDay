// API clients for features 2-6 (groups and scheduling, assistant, duplicates, KPIs, digests).
import { ApiError, api } from './client.js';

const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---- groups, departments, scheduling ----
export const listGroups = (params = {}) => api(`/groups${qs(params)}`);
export const getGroup = (id) => api(`/groups/${id}`);
export const createGroup = (body) => api('/groups', { method: 'POST', body });
export const updateGroup = (id, body) => api(`/groups/${id}`, { method: 'PATCH', body });
export const deleteGroup = (id) => api(`/groups/${id}`, { method: 'DELETE' });
export const addGroupMembers = (id, body) => api(`/groups/${id}/members`, { method: 'POST', body });
export const removeGroupMember = (id, userId) => api(`/groups/${id}/members/${userId}`, { method: 'DELETE' });
export const removeNestedGroup = (id, childId) => api(`/groups/${id}/groups/${childId}`, { method: 'DELETE' });
export const directoryStatus = () => api('/groups/directory/status');
export const syncDirectory = (connectionId) => api('/groups/directory/sync', { method: 'POST', body: { connectionId } });
export const listDepartments = () => api('/departments');
export const createDepartment = (name) => api('/departments', { method: 'POST', body: { name } });
export const renameDepartment = (id, name) => api(`/departments/${id}`, { method: 'PATCH', body: { name } });
export const deleteDepartment = (id) => api(`/departments/${id}`, { method: 'DELETE' });
export const listCalendars = () => api('/scheduling/calendars');
export const searchAttendees = (q) => api(`/scheduling/attendees/search${qs({ q })}`);
export const previewMeeting = (body) => api('/scheduling/meetings/preview', { method: 'POST', body });
export const scheduleMeeting = (body) => api('/scheduling/meetings', { method: 'POST', body });
export const listScheduled = (scope = 'mine') => api(`/scheduling/meetings${qs({ scope })}`);
export const getScheduled = (id) => api(`/scheduling/meetings/${id}`);
export const cancelScheduled = (id, reason) => api(`/scheduling/meetings/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} });

// ---- assistant ----
export const assistantCapabilities = () => api('/assistant/capabilities');
export const listConversations = () => api('/assistant/conversations');
export const getConversation = (id) => api(`/assistant/conversations/${id}`);
export const deleteConversation = (id) => api(`/assistant/conversations/${id}`, { method: 'DELETE' });
export const sendAssistantMessage = (body) => api('/assistant/messages', { method: 'POST', body });
export const chooseOption = (id, key, optionId) => api(`/assistant/commands/${id}/choose`, { method: 'POST', body: { key, optionId } });
export const reviseCommand = (id, body) => api(`/assistant/commands/${id}/revise`, { method: 'POST', body });
export const confirmCommand = (id, largeConfirmed = false) => api(`/assistant/commands/${id}/confirm`, { method: 'POST', body: { largeConfirmed } });
export const cancelCommand = (id) => api(`/assistant/commands/${id}/cancel`, { method: 'POST' });
export const undoCommand = (id) => api(`/assistant/commands/${id}/undo`, { method: 'POST' });
/** Sends a recording (Blob) to the server's speech-to-text. */
export async function transcribe(blob) {
  let res;
  try {
    res = await fetch('/api/v1/assistant/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

// ---- duplicates ----
export const listDuplicates = (params = {}) => api(`/duplicates${qs(params)}`);
export const getDuplicate = (id) => api(`/duplicates/${id}`);
export const dismissDuplicate = (id, reason) => api(`/duplicates/${id}/dismiss`, { method: 'POST', body: reason ? { reason } : {} });
export const linkDuplicate = (id) => api(`/duplicates/${id}/link`, { method: 'POST' });
export const queryDuplicates = (body) => api('/duplicates/query', { method: 'POST', body });
export const duplicatesStatus = () => api('/duplicates/status');
export const sweepDuplicates = () => api('/duplicates/sweep', { method: 'POST' });

// ---- KPIs ----
export const kpiStatus = () => api('/kpi/status');
export const acknowledgeKpiNotice = () => api('/kpi/notice/acknowledge', { method: 'POST' });
export const myKpis = () => api('/kpi/me');
export const myKpiSources = (metric, periodDays) => api(`/kpi/me/sources${qs({ metric, periodDays })}`);
export const flagKpiEvent = (body) => api('/kpi/me/corrections', { method: 'POST', body });
export const restoreKpiEvent = (id) => api(`/kpi/me/corrections/${id}`, { method: 'DELETE' });
export const teamKpis = (teamId) => api(`/kpi/teams/${teamId}`);
export const teamMemberKpis = (teamId, userId) => api(`/kpi/teams/${teamId}/members/${userId}`);
export const hrKpis = () => api('/kpi/hr');
export const hrIndividual = (userId, reason) => api('/kpi/hr/individual', { method: 'POST', body: { userId, reason } });
export const recordKpiConsent = (statement) => api('/kpi/consent', { method: 'POST', body: { statement, confirm: true } });
export const withdrawKpiConsent = () => api('/kpi/consent', { method: 'DELETE' });
export const updateKpiSettings = (body) => api('/kpi/settings', { method: 'PUT', body });
export const computeKpis = () => api('/kpi/compute', { method: 'POST' });

// ---- digests ----
export const listDigests = () => api('/digests');
export const getDigest = (id) => api(`/digests/${id}`);
export const digestPreferences = () => api('/digests/preferences');
export const saveDigestPreferences = (body) => api('/digests/preferences', { method: 'PUT', body });
export const digestSettings = () => api('/digests/settings');
export const saveDigestSettings = (body) => api('/digests/settings', { method: 'PUT', body });
export const generateDigest = () => api('/digests/generate', { method: 'POST', body: {} });
