import { api } from './client.js';

// Integrations dashboard cards and the Microsoft Teams DEVELOPMENT MOCK actions (admins).
export const getOverview = () => api('/integrations/overview');
export const teamsMockView = () => api('/integrations/teams-mock/teams');
export const syncTeamsMock = () => api('/integrations/teams-mock/sync', { method: 'POST' });
export const resetTeamsMock = () => api('/integrations/teams-mock/reset', { method: 'POST' });
