// Integrations dashboard cards: Figma states (configuration required / connected / syncing) and the
// Microsoft Teams DEVELOPMENT MOCK card (labels, counts, actions), and the "View Teams" page.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as integrations from '../../api/integrations.js';
import * as overview from '../../api/integrationOverview.js';
import { IntegrationCards } from './IntegrationCards.jsx';
import { TeamsMockViewPage } from './TeamsMockView.jsx';

vi.mock('../../api/integrations.js');
vi.mock('../../api/integrationOverview.js');

const counts = { teams: 7, channels: 18, meetings: 10, messages: 61, replies: 33, transcriptsImported: 10, employees: 24, departments: 7, workagentTeams: 7, projects: 4 };
const teamsCard = (o = {}) => ({ provider: 'microsoft_teams', displayName: 'Microsoft Teams', available: true, state: 'connected', mode: 'mock', mock: true, connection: { id: 9, lastSyncSucceededAt: '2026-11-15T07:00:00Z' }, teams: { account: 'demo.user@example.com', organisation: 'Violin Technologies', verified: false, counts }, ...o });
const figmaCard = (o = {}) => ({ provider: 'figma', displayName: 'Figma', available: false, problem: 'FIGMA_CLIENT_ID is not set', state: 'not_configured', setupDoc: 'docs/integrations/FIGMA_SETUP.md', connection: null, figma: {}, ...o });
const show = () => render(<MemoryRouter><IntegrationCards onConnect={() => {}} /></MemoryRouter>);

beforeEach(() => {
  window.confirm = () => true;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('integration cards', () => {
  it('Figma without credentials shows Configuration required and what to set', async () => {
    overview.getOverview.mockResolvedValue({ cards: [figmaCard(), teamsCard()] });
    show();
    const f = within(await screen.findByRole('region', { name: 'Figma integration' }));
    expect(f.getByText('Configuration required')).toBeTruthy();
    expect(f.getByText(/FIGMA_CLIENT_ID is not set/)).toBeTruthy();
    expect(f.getByLabelText('Figma logo')).toBeTruthy();
    expect(f.queryByRole('button', { name: 'Connect Figma' })).toBeNull();
  });

  it('connected Figma shows account, team, counts, Sync now and Disconnect; syncing is distinct', async () => {
    const connected = figmaCard({ available: true, problem: null, state: 'connected', connection: { id: 4, lastSyncSucceededAt: '2026-11-15T06:00:00Z' }, figma: { account: 'ada@acme.test', teams: [{ id: '1', name: 'Acme' }], projects: 2, projectsEnabled: 1, files: 5, versions: 30, comments: 12 } });
    overview.getOverview.mockResolvedValue({ cards: [connected] });
    integrations.syncNow.mockResolvedValue({ queued: 1 });
    show();
    const f = within(await screen.findByRole('region', { name: 'Figma integration' }));
    expect(f.getByText('Connected')).toBeTruthy();
    expect(f.getByText('ada@acme.test')).toBeTruthy();
    expect(f.getByText('Acme')).toBeTruthy();
    overview.getOverview.mockResolvedValue({ cards: [{ ...connected, state: 'syncing' }] });
    await userEvent.click(f.getByRole('button', { name: 'Sync now' }));
    expect(integrations.syncNow).toHaveBeenCalledWith(4);
    expect(await f.findByText('Syncing', { selector: 'span' })).toBeTruthy();
    expect(f.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('Microsoft Teams is CONNECTED and labelled DEVELOPMENT MOCK with the seeded counts', async () => {
    overview.getOverview.mockResolvedValue({ cards: [teamsCard()] });
    show();
    const t = within(await screen.findByRole('region', { name: 'Microsoft Teams integration' }));
    expect(t.getByText('CONNECTED')).toBeTruthy();
    expect(t.getByText('DEVELOPMENT MOCK')).toBeTruthy();
    expect(t.getByText('Development mock', { selector: 'span' })).toBeTruthy();
    expect(t.getByText('demo.user@example.com')).toBeTruthy();
    expect(t.getByText('Violin Technologies')).toBeTruthy();
    expect(t.getByText('18')).toBeTruthy();
    expect(t.getByText('61')).toBeTruthy();
    expect(t.getByText(/no Microsoft account is connected or verified/)).toBeTruthy();
    expect(t.getByRole('link', { name: 'View Teams' }).getAttribute('href')).toBe('/admin/integrations/teams-mock');
  });

  it('Sync, Reset and Disconnect call their actions', async () => {
    overview.getOverview.mockResolvedValue({ cards: [teamsCard()] });
    overview.syncTeamsMock.mockResolvedValue({ counts });
    overview.resetTeamsMock.mockResolvedValue({ deleted: { records: 71, meetings: 10, users: 24 } });
    integrations.disconnect.mockResolvedValue({});
    show();
    const t = within(await screen.findByRole('region', { name: 'Microsoft Teams integration' }));
    await userEvent.click(t.getByRole('button', { name: 'Sync Mock Data' }));
    expect(await screen.findByText(/Mock data synced: 7 teams, 18 channels, 10 meetings, 61 messages/)).toBeTruthy();
    await userEvent.click(t.getByRole('button', { name: 'Reset Mock Data' }));
    expect(await screen.findByText(/71 records, 10 meetings and 24 mock employees deleted/)).toBeTruthy();
    await userEvent.click(t.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(integrations.disconnect).toHaveBeenCalledWith(9));
  });

  it('View Teams lists teams, channels, messages with replies and reactions, and meetings', async () => {
    overview.teamsMockView.mockResolvedValue({
      connection: { id: 9 },
      teams: [{ id: 't1', name: 'Payments Team', channels: [{ resourceId: 1, name: 'Refunds', messages: [{ id: 1, author: 'Priya Raman', at: '2026-11-10T10:20:00Z', title: 'Partial refunds', body: 'Partial refunds fail for EUR', reactions: ['like:4'], replies: [{ id: 2, author: 'Diego Alvarez', at: '2026-11-10T10:38:00Z', body: 'Reviewed' }] }] }] }],
      meetings: [{ recordId: 5, title: 'Daily Engineering Standup', start: '2026-11-14T09:00:00Z', team: 'Payments Team', project: 'Payments Platform 2.0', attendees: 8, meetingId: 77, transcriptSegments: 9 }],
    });
    render(<MemoryRouter><TeamsMockViewPage /></MemoryRouter>);
    expect(await screen.findByText('# Refunds')).toBeTruthy();
    expect(screen.getByText('Partial refunds fail for EUR')).toBeTruthy();
    expect(screen.getByText('Reviewed')).toBeTruthy();
    expect(screen.getByText('👍 4')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Daily Engineering Standup' }).getAttribute('href')).toBe('/admin/meetings/77');
    expect(screen.getByText('Transcript: 9 lines')).toBeTruthy();
  });
});
