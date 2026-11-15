// Action Center, action detail (evidence trail, review), the execute panel (exact preview,
// approval, cancel window), Approvals, the Vexa card, and the assistant dock — with the API mocked.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actionsApi from '../../api/actions.js';
import * as vexaApi from '../../api/vexa.js';
import * as features from '../../api/features.js';
import { AssistantDock } from '../../components/AssistantDock.jsx';
import { VexaCard } from '../admin/VexaCard.jsx';
import { ActionCenterPage } from './ActionCenter.jsx';
import { ActionDetailPage } from './ActionDetail.jsx';
import { ApprovalsPage } from './Approvals.jsx';

vi.mock('../../api/actions.js');
vi.mock('../../api/vexa.js');
vi.mock('../../api/features.js');
vi.mock('../../api/projects.js', () => ({ listProjects: () => Promise.resolve({ projects: [{ id: 3, name: 'Payments' }] }) }));
vi.mock('../../api/teams.js', () => ({ listTeams: () => Promise.resolve({ teams: [{ id: 4, name: 'Design' }] }) }));
vi.mock('../../api/directory.js', () => ({ listPeople: () => Promise.resolve({ users: [{ id: 7, fullName: 'Priya Raman' }, { id: 8, fullName: 'Priya Shah' }] }) }));
const auth = vi.hoisted(() => ({ user: { id: 1, role: 'manager', fullName: 'Max Manager', hrAccess: false } }));
vi.mock('../../auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const at = (path, element, route = path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );

const item = (o = {}) => ({
  id: 11,
  title: 'Add a regression test for JPY and EUR amounts',
  description: 'Before the refund fix merges.',
  categoryLabel: 'Code implementation',
  category: 'code_implementation',
  sourceType: 'teams_message',
  sourceLabel: 'Microsoft Teams',
  project: { id: 3, name: 'Payments' },
  assignee: { id: 9, fullName: 'Samuel Osei', isActive: true },
  assigneeKind: 'explicit',
  assigneeTeam: null,
  assigneeNameRaw: 'Samuel Osei',
  dueDate: null,
  dueDateRaw: 'before we merge',
  deadlineStatus: 'needs_clarification',
  priority: 'medium',
  reviewStatus: 'pending',
  taskStatus: 'todo',
  executionStatus: 'none',
  lifecycle: 'needs_review',
  flags: ['ambiguous_deadline'],
  flagLabels: { ambiguous_deadline: 'Deadline is vague or ambiguous' },
  aiConfidence: 0.9,
  meeting: null,
  sourceRecord: { id: 50, url: 'https://teams.example/msg', key: null },
  reviewDetails: { assignee: { candidates: [] } },
  overdue: false,
  ...o,
});
const preview = (o = {}) => ({
  kind: 'email.send',
  summary: 'Send 1 e-mail (assignment)',
  provider: 'email',
  providerLabel: 'E-mail',
  affected: { records: 1, people: 1 },
  recipients: [{ userId: 9, name: 'Samuel Osei', email: 'samuel@violin.test' }],
  drafts: [{ actionItemId: 11, itemIds: [11], title: 'Max Manager assigned you 1 action item → Samuel Osei', target: 'Samuel Osei <samuel@violin.test>', content: { to: 'Samuel Osei <samuel@violin.test>', subject: 'Max Manager assigned you 1 action item', body: 'Hi Samuel, …' }, warnings: [], blockers: [], skipped: null }],
  warnings: [],
  blockers: [],
  requiresLargeConfirmation: false,
  cancelSeconds: 60,
  canApprove: true,
  ...o,
});

beforeEach(() => {
  window.confirm = () => true;
  window.prompt = () => 'Not a task';
  actionsApi.executionCapabilities.mockResolvedValue({
    kinds: [
      { kind: 'jira.create_issue', label: 'Create Jira issues', available: false, problem: 'No Jira project is connected and enabled', targets: [] },
      { kind: 'email.send', label: 'Send e-mail', available: true, problem: null, targets: [] },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Action Center', () => {
  it('shows views with counts, filters by source, and lifecycle states', async () => {
    actionsApi.listActions.mockResolvedValue({ items: [item(), item({ id: 12, title: 'Fix the duplicate refund e-mail', assignee: null, assigneeKind: 'unassigned', lifecycle: 'approved', reviewStatus: 'approved', taskStatus: 'blocked' })], total: 2 });
    actionsApi.actionSummary.mockResolvedValue({ counts: { all: 2, mine: 0, review: 1, overdue: 0, blocked: 1 }, canReview: true });
    at('/actions', <ActionCenterPage />, '/actions');
    expect(await screen.findByText('Add a regression test for JPY and EUR amounts')).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getAllByText('“before we merge”').length).toBe(2);
    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0);
    const views = screen.getByRole('navigation', { name: 'Views' });
    expect(within(views).getByRole('button', { name: /Pending review/ }).textContent).toContain('1');
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'teams_message');
    await waitFor(() => expect(actionsApi.listActions).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'teams_message', view: 'all' })));
    await userEvent.click(within(views).getByRole('button', { name: /Blocked/ }));
    await waitFor(() => expect(actionsApi.listActions).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'blocked' })));
  });

  it('acts on approved selected items through a previewed plan with a cancel window', async () => {
    actionsApi.listActions.mockResolvedValue({ items: [item({ reviewStatus: 'approved', lifecycle: 'approved' })], total: 1 });
    actionsApi.actionSummary.mockResolvedValue({ counts: {}, canReview: true });
    actionsApi.preparePlan.mockResolvedValue({ planId: 77, previewHash: 'h'.repeat(64), preview: preview() });
    actionsApi.approvePlan.mockResolvedValue({ plan: { id: 77 }, cancelUntil: new Date(Date.now() + 60_000).toISOString() });
    actionsApi.cancelPlan.mockResolvedValue({ plan: { id: 77, status: 'cancelled' } });
    at('/actions', <ActionCenterPage />, '/actions');
    await userEvent.click(await screen.findByLabelText('Select Add a regression test for JPY and EUR amounts'));
    await userEvent.click(screen.getByRole('button', { name: 'Act on selected…' }));
    const panel = await screen.findByRole('region', { name: 'Execute action' });
    const select = await within(panel).findByLabelText('Action');
    expect(within(select).getByRole('option', { name: /Create Jira issues — unavailable: No Jira project/ }).disabled).toBe(true);
    await userEvent.selectOptions(select, 'email.send');
    await userEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
    expect(actionsApi.preparePlan).toHaveBeenCalledWith({ kind: 'email.send', actionItemIds: [11], options: {} });
    expect(await within(panel).findByText('Samuel Osei <samuel@violin.test>', { selector: 'dd' })).toBeTruthy();
    expect(within(panel).getByText('Max Manager assigned you 1 action item')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve and execute' }));
    expect(actionsApi.approvePlan).toHaveBeenCalledWith(77, 'h'.repeat(64), false);
    expect(await within(panel).findByText(/runs after the cancel window/)).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(actionsApi.cancelPlan).toHaveBeenCalledWith(77);
  });
});

describe('action detail', () => {
  const detail = (o = {}) => ({
    actionItem: item(),
    evidence: [
      { id: 1, relation: 'origin', excerpt: 'I will add a regression test for JPY and EUR amounts before we merge', speaker: 'Samuel Osei', occurredAt: '2026-11-10T10:00:00Z', record: { id: 50, provider: 'microsoft_teams', recordType: 'message', url: 'https://teams.example/msg' }, meeting: null, startSec: null },
      { id: 2, relation: 'completion', excerpt: 'GitHub pull request “JPY/EUR regression tests” is merged', speaker: null, record: { id: 60, provider: 'github', recordType: 'pull_request', key: 'violin/api#519', url: 'https://github.example/pr/519' }, meeting: null },
    ],
    workStatus: { status: 'implementation_complete', signals: [{ recordId: 60, text: 'GitHub pull request “JPY/EUR regression tests” is merged', signal: 'completion', linkStatus: 'confirmed' }] },
    related: [],
    executions: [{ id: 5, kind: 'jira.create_issue', status: 'retry_required', lastError: 'Jira is unavailable', externalKey: null }],
    history: [{ id: 1, action: 'action_item.created_from_source', actor: 'WorkAgent', at: '2026-11-10T10:01:00Z' }],
    permissions: { canReview: true, canExecute: true, approvalProblems: ['Resolve the flag “Deadline is vague or ambiguous”'] },
    ...o,
  });

  it('shows the evidence trail, the real state of the work and failed executions with retry', async () => {
    actionsApi.getAction.mockResolvedValue(detail());
    actionsApi.retryExecution.mockResolvedValue({});
    at('/actions/11', <ActionDetailPage />, '/actions/:id');
    expect(await screen.findByText(/I will add a regression test for JPY and EUR amounts before we merge/)).toBeTruthy();
    expect(screen.getByText('Where it was agreed')).toBeTruthy();
    expect(screen.getByText('Completion evidence')).toBeTruthy();
    expect(screen.getByText('Linked work finished — confirm it')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open the original' }).map((a) => a.getAttribute('href'))).toEqual(['https://teams.example/msg', 'https://github.example/pr/519']);
    expect(screen.getByText('Jira is unavailable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(actionsApi.retryExecution).toHaveBeenCalledWith(5);
  });

  it('lets a reviewer confirm the deadline, resolve flags and approve', async () => {
    actionsApi.getAction.mockResolvedValue(detail());
    actionsApi.editAction.mockResolvedValue({});
    actionsApi.reviewAction.mockResolvedValue({});
    at('/actions/11', <ActionDetailPage />, '/actions/:id');
    expect(await screen.findByText(/Said: “before we merge” — not resolved, please confirm/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Due date'), '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(actionsApi.editAction).toHaveBeenCalledWith(11, expect.objectContaining({ resolveFlags: ['ambiguous_deadline'], dueDate: '2026-12-01' })));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(actionsApi.reviewAction).toHaveBeenCalledWith(11, 'approve'));
  });
});

describe('Approvals', () => {
  it('lists plans and approves one with its preview hash', async () => {
    actionsApi.listPlans.mockResolvedValue({ plans: [{ id: 77, title: 'Send 1 e-mail', status: 'awaiting_approval', executions: [], preview: preview(), requestedBy: { fullName: 'Ada' }, createdAt: '2026-11-15T10:00:00Z' }] });
    actionsApi.getPlan.mockResolvedValue({ plan: { id: 77, title: 'Send 1 e-mail', status: 'awaiting_approval', origin: 'assistant', preview: preview(), previewHash: 'p'.repeat(64), executions: [], history: [{ action: 'action_plan.prepared', actor: 'Ada', at: '2026-11-15T10:00:00Z' }], requestedBy: { fullName: 'Ada' }, createdAt: '2026-11-15T10:00:00Z' } });
    actionsApi.approvePlan.mockResolvedValue({ plan: { id: 77 } });
    at('/approvals?plan=77', <ApprovalsPage />, '/approvals');
    expect(await screen.findByText('Requested by Ada via assistant', { exact: false })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve and execute' }));
    expect(actionsApi.approvePlan).toHaveBeenCalledWith(77, 'p'.repeat(64), false);
  });
});

describe('Vexa card', () => {
  const overview = (o = {}) => ({
    provider: 'vexa',
    displayName: 'Vexa meeting transcription',
    configured: true,
    state: 'connected',
    account: { email: 'bot@vexa.test', maxConcurrent: 5, verifiedAt: '2026-11-15T09:00:00Z' },
    bot: { name: 'Meeting to Action', platform: 'Google Meet', autoExtract: true, pollIntervalSeconds: 15 },
    webhook: { registered: false, reason: 'polling only' },
    settings: { enabled: true, consent: { statement: 'Participants are told in the invite.' }, scope: 'organizer', internalOnly: false, optOutKeywords: ['#norecord'], joinLeadMinutes: 2, maxDurationHours: 4 },
    discoverySources: [{ provider: 'google_calendar', connections: 1 }],
    counts: { meetingsProcessed: 3, upcoming: 1, active: 0, failed30d: 1, skipped30d: 2 },
    lastTranscript: { meetingId: 4, title: 'Payments sync', at: '2026-11-14T10:00:00Z' },
    sessions: [
      { id: 1, title: 'Design review', state: 'failed', reason: 'The host declined to admit the bot', scheduledStart: '2026-11-14T09:00:00Z', organizerEmail: 'mia@acme.test', meetingId: 8 },
      { id: 2, title: 'Standup', state: 'scheduled', reason: null, scheduledStart: '2026-11-16T09:00:00Z', organizerEmail: 'mia@acme.test' },
    ],
    ...o,
  });

  it('connects once with a consent statement', async () => {
    vexaApi.vexaOverview.mockResolvedValue(overview({ state: 'disconnected', account: null }));
    vexaApi.connectVexa.mockResolvedValue(overview());
    render(<MemoryRouter><VexaCard /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Vexa and turn on automatic transcription' }));
    expect(vexaApi.connectVexa).toHaveBeenCalledWith({ consentStatement: expect.stringMatching(/visible participant/) });
    expect(await screen.findByText('Connected · automatic transcription on')).toBeTruthy();
  });

  it('shows status, counts and sessions, with retry and skip', async () => {
    vexaApi.vexaOverview.mockResolvedValue(overview());
    vexaApi.retryVexaSession.mockResolvedValue({ session: {} });
    vexaApi.skipVexaSession.mockResolvedValue({ session: {} });
    render(<MemoryRouter><VexaCard /></MemoryRouter>);
    expect(await screen.findByText('bot@vexa.test', { exact: false })).toBeTruthy();
    expect(screen.getByText('The host declined to admit the bot')).toBeTruthy();
    expect(screen.getByText('Google Calendar')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(vexaApi.retryVexaSession).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole('button', { name: 'Don’t record' }));
    expect(vexaApi.skipVexaSession).toHaveBeenCalledWith(2);
  });

  it('explains what the server is missing', async () => {
    vexaApi.vexaOverview.mockResolvedValue(overview({ state: 'not_configured', configured: false }));
    render(<MemoryRouter><VexaCard /></MemoryRouter>);
    expect(await screen.findByText('Configuration required')).toBeTruthy();
    expect(screen.getByText('VEXA_API_KEY')).toBeTruthy();
  });
});

describe('assistant dock', () => {
  it('is available on other pages and keeps the full assistant one click away', async () => {
    features.assistantCapabilities.mockResolvedValue({ ai: { configured: true }, speech: {} });
    render(
      <MemoryRouter initialEntries={['/actions']}>
        <AssistantDock />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask WorkAgent' }));
    const dialog = screen.getByRole('dialog', { name: 'WorkAgent assistant' });
    expect(within(dialog).getByText(/Create Jira tickets for all approved engineering action items/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Full screen' }).getAttribute('href')).toBe('/assistant');
  });

  it('is hidden on the Assistant page itself', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/assistant/3']}>
        <AssistantDock />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('');
  });
});
