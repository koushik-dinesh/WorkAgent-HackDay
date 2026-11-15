// Features 2-6 in the UI, with the API mocked: the attendee picker and two-step scheduling
// (review, large-invitation confirmation, changed list), the assistant's choices, confirmation
// card, blockers and undo, duplicate review actions, the KPI notice gate and the access log,
// HR/permission-denied states, and digest sections with source links.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/features.js';
import { ApiError } from '../api/client.js';
import { AssistantPage } from './assistant/Assistant.jsx';
import { DigestDetailPage } from './digests/Digests.jsx';
import { DuplicatesPage } from './duplicates/Duplicates.jsx';
import { HrKpiPage, MyKpiPage, TeamKpiPage } from './kpi/Kpi.jsx';
import { ScheduleMeetingPage } from './scheduling/ScheduleMeeting.jsx';

vi.mock('../api/features.js');
const auth = vi.hoisted(() => ({ user: { id: 1, role: 'manager', fullName: 'Max', hrAccess: false } }));
vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const at = (path, element, route = path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  window.confirm = () => true;
  window.prompt = () => 'Different service';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('group invitations', () => {
  const preview = (extra = {}) => ({
    meeting: { title: 'Design review', startAt: '2026-11-20T10:00:00Z', timeZone: 'UTC' },
    calendar: { provider: 'workagent', label: 'WorkAgent only', canWrite: true },
    invitees: [{ id: 5, fullName: 'Priya Shah', via: [{ type: 'group', groupId: 3, name: 'Payments' }] }],
    excluded: [],
    groups: [{ id: 3, name: 'Payments', type: 'department', memberCount: 1, large: false }],
    total: 1,
    threshold: 50,
    requiresLargeConfirmation: false,
    recipientsHash: 'a'.repeat(64),
    availability: { checked: false, problem: 'Connect your calendar', conflicts: [], suggestions: [] },
    warnings: ['No calendar event will be created: invitees are told inside WorkAgent only.'],
    ...extra,
  });
  beforeEach(() => {
    api.listCalendars.mockResolvedValue({ calendars: [{ provider: 'workagent', connectionId: null, label: 'WorkAgent only', canWrite: true }, { provider: 'outlook', connectionId: 9, label: 'Outlook · me', canWrite: false, problem: 'This connection can only read the calendar.' }] });
    api.searchAttendees.mockResolvedValue({ results: [{ kind: 'department', id: 3, label: 'Payments', memberCount: 1 }, { kind: 'person', id: 5, label: 'Priya Shah', detail: 'QA' }] });
    api.getGroup.mockResolvedValue({ members: [{ id: 5, fullName: 'Priya Shah' }] });
  });

  async function fillAndPick() {
    await userEvent.type(screen.getByLabelText('Title'), 'Design review');
    await userEvent.type(screen.getByLabelText('Starts'), '2026-11-20T10:00');
    await userEvent.type(screen.getByLabelText(/Search people, departments/), 'pay');
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('Department')).toBeTruthy();
    await userEvent.click(within(list).getByText('Payments'));
  }

  it('shows type badges, read-only calendars, and requires review before sending', async () => {
    api.previewMeeting.mockResolvedValue(preview());
    api.scheduleMeeting.mockResolvedValue({ meeting: { id: 77 } });
    at('/meetings/schedule', <ScheduleMeetingPage />);
    await fillAndPick();
    expect(screen.getByRole('option', { name: /Outlook · me — read-only/ }).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Show members' }));
    expect(await screen.findByText('Priya Shah')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Review attendees' }));
    expect(await screen.findByText(/will be invited/)).toBeTruthy();
    expect(screen.getByText(/via Payments/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Send 1 invitation' }));
    await waitFor(() => expect(api.scheduleMeeting).toHaveBeenCalled());
    expect(api.scheduleMeeting.mock.calls[0][0]).toMatchObject({ confirm: true, recipientsHash: 'a'.repeat(64), attendees: { groupIds: [3] } });
    expect(await screen.findByText('elsewhere')).toBeTruthy();
  });

  it('needs the large-invitation checkbox, and asks to review again when the list changed', async () => {
    api.previewMeeting.mockResolvedValue(preview({ total: 60, requiresLargeConfirmation: true }));
    api.scheduleMeeting.mockRejectedValue(new ApiError(409, 'RECIPIENTS_CHANGED', 'changed'));
    at('/meetings/schedule', <ScheduleMeetingPage />);
    await fillAndPick();
    await userEvent.click(screen.getByRole('button', { name: 'Review attendees' }));
    const send = await screen.findByRole('button', { name: 'Send 60 invitations' });
    expect(send.disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /I confirm this large invitation/ }));
    expect(send.disabled).toBe(false);
    await userEvent.click(send);
    expect(await screen.findByText(/attendee list changed/)).toBeTruthy();
  });
});

describe('assistant', () => {
  let latest = null;
  const conv = (commands, messages) => {
    latest = { conversation: { id: 4, title: 'x' }, commands, messages };
    return latest;
  };
  beforeEach(() => {
    // The page reloads the conversation after navigating to /assistant/4.
    api.getConversation.mockImplementation(() => Promise.resolve(latest));
    api.assistantCapabilities.mockResolvedValue({ ai: { configured: true }, speech: { configured: false }, calendars: [] });
    api.listConversations.mockResolvedValue({ conversations: [] });
  });

  it('offers choices, then a confirmation card; confirm executes and shows undo', async () => {
    const choice = { id: 9, status: 'needs_clarification', resolution: { pending: [{ key: 'assignee', reason: 'More than one person is called “Priya”', options: [{ id: 5, label: 'Priya Shah' }, { id: 6, label: 'Priya Nair' }] }] } };
    const first = conv([choice], [{ id: 1, role: 'user', content: 'Assign it to Priya' }, { id: 2, role: 'assistant', content: 'More than one person', commandId: 9 }]);
    api.sendAssistantMessage.mockResolvedValue(first);
    const plan = { action: 'jira_create', headline: 'Create a Jira issue in PAY and assign it to Priya Shah', provider: 'jira', externalWrite: true, requestedBy: 'Max', fields: [{ label: 'Assignee', value: 'Priya Shah' }, { label: 'Due date', value: '2026-11-20', flagged: true }], affected: [{ fullName: 'Priya Shah', role: 'assignee' }], warnings: ['The due date was read by the AI'], blockers: [], undo: 'Can be undone' };
    api.chooseOption.mockImplementation(async () => conv([{ id: 9, status: 'awaiting_confirmation', plan }], [{ id: 3, role: 'assistant', content: 'Check the details', commandId: 9 }]));
    api.confirmCommand.mockImplementation(async () => conv([{ id: 9, status: 'executed', externalKey: 'PAY-7', provider: 'jira', canUndo: true, undoDeadline: new Date(Date.now() + 60_000).toISOString() }], [{ id: 4, role: 'assistant', content: 'Created PAY-7', commandId: 9 }]));
    latest = first;
    at('/assistant', <AssistantPage />, '/assistant/:id?');
    await userEvent.type(screen.getByLabelText('Your request'), 'Assign it to Priya');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Priya Shah' }));
    expect(api.chooseOption).toHaveBeenCalledWith(9, 'assignee', 5);
    const card = await screen.findByRole('group', { name: 'Confirm action' });
    expect(within(card).getByText(/writes to Jira/)).toBeTruthy();
    expect(within(card).getByText('2026-11-20 ⚠')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('button', { name: /Undo \(\d+s\)/ })).toBeTruthy();
  });

  it('disables Confirm when the plan has blockers, and voice when unavailable', async () => {
    const plan = { action: 'task_update', headline: 'Update task', provider: 'workagent', fields: [], warnings: [], blockers: ['Only an admin or the project’s manager can change this task'], undo: '' };
    api.sendAssistantMessage.mockResolvedValue(conv([{ id: 2, status: 'awaiting_confirmation', plan }], [{ id: 1, role: 'assistant', content: 'Check', commandId: 2 }]));
    at('/assistant', <AssistantPage />, '/assistant/:id?');
    expect((await screen.findByRole('button', { name: 'Speak a request' })).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Your request'), 'raise priority');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const card = await screen.findByRole('group', { name: 'Confirm action' });
    expect(within(card).getByText(/Only an admin/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Confirm' }).disabled).toBe(true);
  });
});

describe('duplicates', () => {
  const cand = { id: 1, tier: 'high', method: 'embedding', similarity: 0.91, structuralScore: 0.95, structuralEvidence: [{ kind: 'shared_files', values: ['src/auth/refresh.js'] }], verdict: 'same', explanation: 'Both fix the refresh.', status: 'open', a: { type: 'external_record', id: 3, key: 'AUTH-1', title: 'Refresh fails', provider: 'jira', recordType: 'issue' }, b: { type: 'action_item', id: 8, title: 'Fix refresh', assigneeName: 'Raj' }, permissions: { canLink: false } };
  it('shows evidence and verdict; “Not a duplicate” sends the reason; link hidden without permission', async () => {
    api.listDuplicates.mockResolvedValue({ candidates: [cand] });
    api.dismissDuplicate.mockResolvedValue({ candidate: { ...cand, status: 'dismissed' } });
    at('/duplicates', <DuplicatesPage />);
    expect(await screen.findByText(/Same files: src\/auth\/refresh.js/)).toBeTruthy();
    expect(screen.getByText(/AI verdict: same work/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link as duplicates' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Not a duplicate' }));
    expect(api.dismissDuplicate).toHaveBeenCalledWith(1, 'Different service');
    expect(await screen.findByText('Not a duplicate', { selector: 'span' })).toBeTruthy();
  });
});

describe('work metrics', () => {
  const status = { enabled: true, acknowledged: false, notice: { version: 1, text: 'Para one.\n\nPara two.' }, neverCollected: ['Keystrokes, mouse or screen activity'], advisory: 'Advisory only.', access: { teams: [] }, orgConsent: { at: '2026-11-01' } };
  it('requires the notice first, then shows metrics, sources and the access log', async () => {
    api.myKpis.mockResolvedValueOnce({ status, data: null });
    api.acknowledgeKpiNotice.mockResolvedValue({});
    const data = { person: { id: 1 }, periodEnd: '2026-11-14', metrics: [{ key: 'commitment_reliability', label: 'Commitment reliability', unit: 'ratio', periodDays: 28, value: 0.6667, numerator: 2, denominator: 3, status: 'ok', sourceCount: 3, details: {} }, { key: 'review_contribution', label: 'Review contribution', unit: 'count', periodDays: 28, value: null, status: 'not_observable', sourceCount: 0, details: { reason: 'No linked GitHub or Figma account' } }], profile: [{ dimension: 'reliability_band', value: 'typical', details: {} }] };
    api.myKpis.mockResolvedValue({ status: { ...status, acknowledged: true }, data, accessLog: [{ scope: 'hr_drilldown', viewer: 'Hana HR', reason: 'Workload concern', at: '2026-11-15T10:00:00Z' }], corrections: [] });
    api.myKpiSources.mockResolvedValue({ sources: [{ ref: { type: 'action_item', id: 4 }, summary: { title: 'Task four' }, excluded: false }] });
    at('/my/kpi', <MyKpiPage />);
    expect(await screen.findByText(/Keystrokes/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'I have read this notice' }));
    expect(await screen.findByText('67%')).toBeTruthy();
    expect(screen.getByText('Not observable')).toBeTruthy();
    expect(screen.getByText(/Hana HR \(hr drilldown\): “Workload concern”/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '3 source events' }));
    expect(await screen.findByText('Task four')).toBeTruthy();
    expect(screen.queryByText(/score/i)).toBeNull();
  });
  it('shows permission-denied states for team and HR views', async () => {
    api.teamKpis.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'no'));
    at('/kpi/teams/3', <TeamKpiPage />, '/kpi/teams/:id');
    expect(await screen.findByText(/Only the team lead/)).toBeTruthy();
    cleanup();
    api.hrKpis.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'no'));
    at('/kpi/hr', <HrKpiPage />);
    expect(await screen.findByText(/HR access is required/)).toBeTruthy();
  });
});

describe('weekly digest', () => {
  it('shows computed counts, the narrative note and source links', async () => {
    api.getDigest.mockResolvedValue({
      digest: { id: 1, scopeName: 'Payments', audience: 'manager', periodStart: '2026-11-13T11:30:00Z', periodEnd: '2026-11-20T11:30:00Z', headline: null, narrativeNote: 'The AI narrative was withheld because it contained figures that are not in the data.' },
      counts: { shipped: 2, slipped: 1, blockers: 0, commitmentsAtRisk: 1, decisions: 1, onTimeShare: 67 },
      sections: [{ key: 'slipped', label: 'Slipped', items: [{ title: 'Refund fix', owner: 'Dana', daysOverdue: 4, ref: { href: '/projects/2' } }], narrative: null }, { key: 'team_load', label: 'Team load', items: { available: false, reason: 'KPI tracking is off' } }],
      suppressed: ['decisions'],
      deliveries: [],
    });
    at('/digests/1', <DigestDetailPage />, '/digests/:id');
    expect(await screen.findByText('67%')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Refund fix' }).getAttribute('href')).toBe('/projects/2');
    expect(screen.getByText(/4 days overdue/)).toBeTruthy();
    expect(screen.getByText(/withheld/)).toBeTruthy();
    expect(screen.getByText(/KPI tracking is off/)).toBeTruthy();
    expect(screen.getByText(/1 section\(s\) hidden/)).toBeTruthy();
  });
});
