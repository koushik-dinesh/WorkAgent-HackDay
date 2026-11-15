// Vexa meeting transcription: one-time connection and automatic Google Meet transcription.
import { api } from './client.js';

export const vexaOverview = () => api('/integrations/vexa');
export const connectVexa = (body) => api('/integrations/vexa/connect', { method: 'POST', body });
export const disconnectVexa = () => api('/integrations/vexa/disconnect', { method: 'POST' });
export const saveVexaSettings = (body) => api('/integrations/vexa/settings', { method: 'PUT', body });
export const syncVexa = () => api('/integrations/vexa/sync', { method: 'POST' });
export const retryVexaSession = (id) => api(`/integrations/vexa/sessions/${id}/retry`, { method: 'POST' });
export const skipVexaSession = (id) => api(`/integrations/vexa/sessions/${id}/skip`, { method: 'POST' });
