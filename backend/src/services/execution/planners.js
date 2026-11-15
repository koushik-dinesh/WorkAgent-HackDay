// Planners: turn "do X for these action items" into exact, reviewable writes. A planner decides the
// target (which Jira project, repository, channel, calendar), the recipients (only people from the
// WorkAgent directory, with the address stored there — never an address from text), the exact
// content, and what blocks or skips each write. It writes nothing.
import { pool } from '../../db/pool.js';
import { AppError, badRequest } from '../../utils/errors.js';
import { assertJiraPermissions, jiraAccountOf, jiraContext, JIRA_PRIORITY } from '../assistant/executor.js';
import { email } from '../email/index.js';
import { registry } from '../integrations/registry.js';
import { previewMeeting } from '../scheduling/index.js';
import { commentBody, issueBody, renderEmail, renderTeams, TEMPLATES } from './messages.js';

export const KINDS = {
  'jira.create_issue': { label: 'Create Jira issues', provider: 'jira', providerLabel: 'Jira', needsItems: true, options: ['resourceId'] },
  'jira.comment': { label: 'Comment on the linked Jira issues', provider: 'jira', providerLabel: 'Jira', needsItems: true, options: ['text'] },
  'jira.update': { label: 'Update the linked Jira issues', provider: 'jira', providerLabel: 'Jira', needsItems: true, options: ['priority', 'dueDate', 'syncAssignee'] },
  'jira.transition': { label: 'Change the status of the linked Jira issues', provider: 'jira', providerLabel: 'Jira', needsItems: true, options: ['status'] },
  'jira.link': { label: 'Link related Jira issues', provider: 'jira', providerLabel: 'Jira', needsItems: true, options: ['toKey'] },
  'email.send': { label: 'Send e-mail', provider: 'email', providerLabel: 'E-mail', needsItems: false, options: ['template', 'note', 'subject', 'recipientUserIds', 'meetingId'] },
  'teams.message': { label: 'Post to a Microsoft Teams channel', provider: 'microsoft_teams', providerLabel: 'Microsoft Teams', needsItems: true, options: ['resourceId', 'template', 'note'] },
  'github.create_issue': { label: 'Create GitHub issues', provider: 'github', providerLabel: 'GitHub', needsItems: true, options: ['resourceId'] },
  'github.comment': { label: 'Comment on the linked GitHub issue or pull request', provider: 'github', providerLabel: 'GitHub', needsItems: true, options: ['text'] },
  'calendar.schedule': { label: 'Schedule a meeting', provider: 'calendar', providerLabel: 'Calendar', needsItems: false, options: ['title', 'startAt', 'durationMinutes', 'timeZone', 'provider', 'connectionId', 'attendees', 'excludedUserIds'], maxAttempts: 2 },
  'workagent.notify': { label: 'Notify in WorkAgent', provider: 'workagent', providerLabel: 'WorkAgent notifications', needsItems: true, options: ['template', 'note'], ownItemsAllowed: false },
};

const short = (s, n = 140) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

async function evidenceOf(itemId) {
  const [rows] = await pool.query("SELECT excerpt, speaker FROM action_item_evidence WHERE action_item_id = ? AND relation IN ('origin','supporting') ORDER BY id LIMIT 5", [itemId]);
  return rows;
}

async function directoryUsers(ids) {
  if (!ids.length) return new Map();
  const [rows] = await pool.query('SELECT id, email, full_name, is_active FROM users WHERE id IN (?)', [ids]);
  return new Map(rows.map((u) => [u.id, { id: u.id, email: u.email, fullName: u.full_name, isActive: Boolean(u.is_active) }]));
}

async function activeResources(provider, resourceType) {
  const [rows] = await pool.query(
    `SELECT r.id, r.connection_id, r.external_id, r.name, r.project_id, r.metadata FROM integration_resources r JOIN integration_connections c ON c.id = r.connection_id
      WHERE c.provider = ? AND c.status = 'active' AND r.resource_type = ? AND r.is_enabled = TRUE AND r.access_status = 'accessible' ORDER BY r.id`,
    [provider, resourceType],
  );
  return rows.map((r) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {} }));
}

/** The resource for an item: chosen explicitly, mapped to the item's project, or the only one. */
function pickResource(resources, item, resourceId) {
  if (resourceId) return resources.find((r) => r.id === Number(resourceId)) ?? null;
  const byProject = resources.filter((r) => item.projectId && r.project_id === item.projectId);
  if (byProject.length === 1) return byProject[0];
  return resources.length === 1 ? resources[0] : null;
}

/** Linked records of a provider/type for an item: created by an execution, or confirmed links. */
async function linkedRecords(itemId, provider, recordTypes) {
  const [rows] = await pool.query(
    `SELECT DISTINCT er.id, er.external_key, er.external_id, er.title, er.url, er.resource_id, er.connection_id, er.metadata, er.record_type
       FROM external_records er
      WHERE er.provider = ? AND er.record_type IN (?) AND er.source_deleted_at IS NULL AND (
            er.id IN (SELECT external_record_id FROM action_executions WHERE action_item_id = ? AND status IN ('succeeded','verified') AND external_record_id IS NOT NULL)
         OR er.id IN (SELECT to_id FROM record_links WHERE from_type = 'action_item' AND from_id = ? AND to_type = 'external_record' AND status = 'confirmed')
         OR er.id IN (SELECT from_id FROM record_links WHERE to_type = 'action_item' AND to_id = ? AND from_type = 'external_record' AND status = 'confirmed'))`,
    [provider, recordTypes, itemId, itemId, itemId],
  );
  return rows.map((r) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {} }));
}

const blocker = (text) => ({ blockers: [text] });

// ---- Jira -----------------------------------------------------------------------------------------

async function jiraAvailability(user) {
  const c = registry.getAvailable('jira');
  if (!c) return `Jira is not configured on the server: ${registry.problem('jira')}`;
  const resources = await activeResources('jira', 'project');
  if (!resources.length) return 'No Jira project is connected and enabled';
  const [[conn]] = await pool.query("SELECT settings FROM integration_connections WHERE id = ?", [resources[0].connection_id]);
  const scopes = (typeof conn?.settings === 'string' ? JSON.parse(conn.settings) : conn?.settings)?.scopes ?? [];
  if (!scopes.includes('write:jira-work')) return 'The Jira connection can only read (turn on JIRA_ISSUE_CREATION and reconnect)';
  if (!(await jiraAccountOf(c.sourceInstance, user.id))) return 'Your WorkAgent account is not linked to a Jira account (an admin links it under Integrations → People)';
  return null;
}

async function planJiraCreate(user, items, { resourceId }) {
  const resources = await activeResources('jira', 'project');
  const drafts = [];
  for (const item of items) {
    const resource = pickResource(resources, item, resourceId);
    if (!resource) {
      drafts.push({ actionItemId: item.id, title: item.title, ...blocker(resources.length ? 'Choose the Jira project' : 'No Jira project is connected'), payload: {} });
      continue;
    }
    const c = registry.getAvailable('jira');
    const accountId = c && item.assignee ? await jiraAccountOf(c.sourceInstance, item.assignee.id) : null;
    const ev = await evidenceOf(item.id);
    const payload = {
      itemIds: [item.id],
      summary: short(item.title, 250),
      description: issueBody(item, ev, user),
      priority: item.priority,
      jiraPriority: JIRA_PRIORITY[item.priority] ?? null,
      dueDate: item.dueDate ?? null,
      assigneeUserId: item.assignee?.id ?? null,
      assigneeAccountId: accountId,
      label: `workagent-item-${item.id}`,
    };
    drafts.push({
      actionItemId: item.id,
      title: item.title,
      resourceId: resource.id,
      connectionId: resource.connection_id,
      target: { resourceId: resource.id, projectKey: resource.metadata.key },
      targetLabel: `Jira project ${resource.metadata.key ?? resource.name}`,
      payload,
      affectedUserIds: item.assignee ? [item.assignee.id] : [],
      preview: { summary: payload.summary, description: payload.description, priority: payload.jiraPriority ?? item.priority, dueDate: payload.dueDate, assignee: item.assignee?.fullName ?? null, labels: [payload.label] },
      warnings: [
        ...(item.assignee && !accountId ? [`${item.assignee.fullName} has no linked Jira account: the issue will be unassigned`] : []),
        ...(!item.dueDate && item.dueDateRaw ? [`The deadline “${item.dueDateRaw}” is not confirmed, so no due date is set`] : []),
      ],
    });
  }
  return { drafts, summary: `Create ${drafts.length} Jira issue${drafts.length === 1 ? '' : 's'}` };
}

async function linkedJiraDrafts(items, build) {
  const drafts = [];
  for (const item of items) {
    const [issue] = await linkedRecords(item.id, 'jira', ['issue']);
    if (!issue) {
      drafts.push({ actionItemId: item.id, title: item.title, ...blocker('No Jira issue is linked to this item (create one or confirm a suggested link first)'), payload: {} });
      continue;
    }
    drafts.push({ actionItemId: item.id, title: item.title, resourceId: issue.resource_id, connectionId: issue.connection_id, target: { recordId: issue.id, key: issue.external_key, resourceId: issue.resource_id }, targetLabel: `Jira ${issue.external_key}`, ...(await build(item, issue)) });
  }
  return drafts;
}

async function planJiraComment(user, items, { text }) {
  if (!text || !String(text).trim()) throw badRequest('Write the comment text', [{ field: 'text', message: 'Required' }]);
  const drafts = await linkedJiraDrafts(items, async (item) => {
    const body = commentBody(item, String(text).trim().slice(0, 5000), user);
    return { payload: { itemIds: [item.id], text: body }, preview: { comment: body } };
  });
  return { drafts, summary: `Comment on ${drafts.length} Jira issue${drafts.length === 1 ? '' : 's'}` };
}

async function planJiraUpdate(user, items, { priority, dueDate, syncAssignee }) {
  if (!priority && dueDate === undefined && !syncAssignee) throw badRequest('Choose what to change', [{ field: 'priority', message: 'Priority, due date or assignee' }]);
  const c = registry.getAvailable('jira');
  const drafts = await linkedJiraDrafts(items, async (item) => {
    const changes = {};
    const warnings = [];
    if (priority) changes.priority = JIRA_PRIORITY[priority] ?? priority;
    if (dueDate !== undefined) changes.dueDate = dueDate ?? item.dueDate ?? null;
    if (syncAssignee) {
      const accountId = c && item.assignee ? await jiraAccountOf(c.sourceInstance, item.assignee.id) : null;
      if (accountId) changes.assigneeAccountId = accountId;
      else warnings.push(`${item.assignee?.fullName ?? 'The owner'} has no linked Jira account: the assignee is not changed`);
    }
    return { payload: { itemIds: [item.id], changes }, preview: { changes }, warnings, affectedUserIds: item.assignee ? [item.assignee.id] : [] };
  });
  return { drafts, summary: `Update ${drafts.length} Jira issue${drafts.length === 1 ? '' : 's'}` };
}

async function planJiraTransition(user, items, { status }) {
  if (!status) throw badRequest('Choose the new Jira status', [{ field: 'status', message: 'Required' }]);
  const drafts = await linkedJiraDrafts(items, async (item) => ({ payload: { itemIds: [item.id], statusName: String(status).slice(0, 60) }, preview: { newStatus: status } }));
  return { drafts, summary: `Move ${drafts.length} Jira issue${drafts.length === 1 ? '' : 's'} to “${status}”`, warnings: ['Jira decides which transitions are allowed; an impossible transition fails and stays retryable'] };
}

async function planJiraLink(user, items, { toKey }) {
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(String(toKey ?? ''))) throw badRequest('Give the Jira key to link to, e.g. PAY-42', [{ field: 'toKey', message: 'Required' }]);
  const drafts = await linkedJiraDrafts(items, async (item, issue) => (issue.external_key === toKey ? { ...blocker('The issue cannot be linked to itself'), payload: {} } : { payload: { itemIds: [item.id], toKey }, preview: { link: `${issue.external_key} relates to ${toKey}` } }));
  return { drafts, summary: `Link ${drafts.length} Jira issue${drafts.length === 1 ? '' : 's'} to ${toKey}` };
}

// ---- e-mail ---------------------------------------------------------------------------------------

async function managerOf(item) {
  if (item.projectId) {
    const [[p]] = await pool.query('SELECT owner_user_id FROM projects WHERE id = ?', [item.projectId]);
    if (p?.owner_user_id && p.owner_user_id !== item.assignee?.id) return p.owner_user_id;
  }
  if (item.assignee) {
    const [[t]] = await pool.query('SELECT t.lead_user_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? AND t.lead_user_id IS NOT NULL AND t.lead_user_id <> ? ORDER BY t.id LIMIT 1', [item.assignee.id, item.assignee.id]);
    if (t) return t.lead_user_id;
  }
  if (item.assigneeTeam) {
    const [[t]] = await pool.query('SELECT lead_user_id FROM teams WHERE id = ?', [item.assigneeTeam.id]);
    if (t?.lead_user_id) return t.lead_user_id;
  }
  return null;
}

async function planEmail(user, items, { template = 'assignment', note = null, subject = null, recipientUserIds = [], meetingId = null }) {
  if (!TEMPLATES.includes(template)) throw badRequest('Unknown e-mail template', [{ field: 'template', message: TEMPLATES.join(', ') }]);
  const blockers = email.isConfigured() ? [] : [`E-mail sending is not configured on the server (${email.configurationProblem()})`];
  // recipient id -> items
  const groups = new Map();
  const skipped = [];
  let meeting = null;
  if (template === 'meeting_summary') {
    if (!meetingId && items[0]?.meeting) meetingId = items[0].meeting.id;
    if (!meetingId) throw badRequest('Choose the meeting', [{ field: 'meetingId', message: 'Required' }]);
    const [[m]] = await pool.query('SELECT id, title, scheduled_at FROM meetings WHERE id = ?', [meetingId]);
    if (!m) throw badRequest('Unknown meeting');
    meeting = { id: m.id, title: m.title, scheduledAt: m.scheduled_at };
    const [participants] = await pool.query('SELECT user_id FROM meeting_participants WHERE meeting_id = ?', [meetingId]);
    const meetingItems = items.filter((i) => i.meeting?.id === meetingId);
    for (const p of participants) groups.set(p.user_id, meetingItems);
  } else if (template === 'custom') {
    if (!recipientUserIds.length) throw badRequest('Choose the recipients', [{ field: 'recipientUserIds', message: 'Required' }]);
    if (!subject || !note) throw badRequest('Write the subject and message', [{ field: 'note', message: 'Required' }]);
    for (const id of recipientUserIds) groups.set(Number(id), items);
  } else {
    for (const item of items) {
      const to = ['overdue_escalation', 'blocker_escalation'].includes(template) ? await managerOf(item) : item.assignee?.id ?? null;
      if (!to) {
        skipped.push({ actionItemId: item.id, title: item.title, skip: { reason: template.endsWith('escalation') ? 'No manager found (project owner or team lead)' : 'No owner: assign someone before e-mailing' }, payload: {} });
        continue;
      }
      groups.set(to, [...(groups.get(to) ?? []), item]);
    }
  }
  const people = await directoryUsers([...groups.keys()]);
  const drafts = [...skipped];
  const recipients = [];
  for (const [userId, its] of groups) {
    const u = people.get(userId);
    if (!u || !u.isActive || !u.email) {
      drafts.push({ title: `E-mail to user #${userId}`, skip: { reason: 'Not an active WorkAgent user with an e-mail address' }, payload: {} });
      continue;
    }
    if (template !== 'custom' && template !== 'meeting_summary' && !its.length) continue;
    const msg = renderEmail(template, { recipient: u, requester: user, items: its, meeting, note, subject });
    recipients.push({ userId: u.id, name: u.fullName, email: u.email });
    drafts.push({
      actionItemId: its.length === 1 ? its[0].id : null,
      title: `${msg.subject} → ${u.fullName}`,
      target: { userId: u.id },
      targetLabel: `${u.fullName} <${u.email}>`,
      payload: { itemIds: its.map((i) => i.id), template, recipientUserId: u.id, recipientEmail: u.email, subject: msg.subject, text: msg.text, html: msg.html, meetingId: meeting?.id ?? null },
      affectedUserIds: [u.id],
      preview: { to: `${u.fullName} <${u.email}>`, subject: msg.subject, body: msg.text },
    });
  }
  return { drafts, recipients, blockers, summary: `Send ${recipients.length} e-mail${recipients.length === 1 ? '' : 's'} (${template.replaceAll('_', ' ')})` };
}

// ---- Teams ----------------------------------------------------------------------------------------

async function planTeams(user, items, { resourceId, template = 'assignment', note = null }) {
  const channels = await activeResources('microsoft_teams', 'channel');
  const channel = resourceId ? channels.find((c) => c.id === Number(resourceId)) : channels.length === 1 ? channels[0] : null;
  const connector = registry.getAvailable('microsoft_teams');
  const blockers = [];
  if (!connector) blockers.push(`Microsoft Teams is not available: ${registry.problem('microsoft_teams')}`);
  if (!channel) blockers.push(channels.length ? 'Choose the Teams channel' : 'No Teams channel is connected and enabled');
  if (channel && connector) {
    const [[c]] = await pool.query('SELECT settings FROM integration_connections WHERE id = ?', [channel.connection_id]);
    const conn = { settings: typeof c.settings === 'string' ? JSON.parse(c.settings) : c.settings };
    if (!connector.canSendMessages?.(conn)) blockers.push('The Teams connection may not post messages (set TEAMS_MESSAGE_SEND=true and reconnect Teams)');
  }
  const html = renderTeams(template, { requester: user, items, note, meeting: items[0]?.meeting });
  const mock = Boolean(channel?.metadata?.isMock);
  const drafts = channel
    ? [{
        title: `Post to ${channel.name}`,
        resourceId: channel.id,
        connectionId: channel.connection_id,
        target: { resourceId: channel.id, teamId: channel.metadata.teamId, channelId: channel.metadata.channelId },
        targetLabel: `${channel.name}${mock ? ' (DEVELOPMENT MOCK — nothing is sent to Microsoft)' : ''}`,
        payload: { itemIds: items.map((i) => i.id), html, template },
        affectedUserIds: items.map((i) => i.assignee?.id).filter(Boolean),
        preview: { channel: channel.name, message: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() },
      }]
    : [];
  return { drafts, blockers, summary: `Post ${items.length} action item${items.length === 1 ? '' : 's'} to Teams`, warnings: mock ? ['Teams runs as a development mock: the message is stored in WorkAgent only'] : [] };
}

// ---- GitHub ---------------------------------------------------------------------------------------

async function githubLoginOf(userId) {
  const [[r]] = await pool.query("SELECT login FROM external_identities WHERE provider = 'github' AND user_id = ? AND is_bot = FALSE ORDER BY updated_at DESC LIMIT 1", [userId]);
  return r?.login ?? null;
}

async function githubWriteProblem(connectionId) {
  const connector = registry.getAvailable('github');
  if (!connector) return `GitHub is not configured: ${registry.problem('github')}`;
  const [[c]] = await pool.query('SELECT settings FROM integration_connections WHERE id = ?', [connectionId]);
  const settings = typeof c?.settings === 'string' ? JSON.parse(c.settings) : c?.settings;
  return connector.canWriteIssues({ settings }) ? null : 'The GitHub App installation can only read issues (grant “Issues: Read and write” on GitHub and refresh the connection)';
}

async function planGithubIssue(user, items, { resourceId }) {
  const repos = await activeResources('github', 'repository');
  const drafts = [];
  for (const item of items) {
    const repo = pickResource(repos, item, resourceId);
    if (!repo) {
      drafts.push({ actionItemId: item.id, title: item.title, ...blocker(repos.length ? 'Choose the repository' : 'No GitHub repository is connected'), payload: {} });
      continue;
    }
    const problem = await githubWriteProblem(repo.connection_id);
    const login = item.assignee ? await githubLoginOf(item.assignee.id) : null;
    const body = issueBody(item, await evidenceOf(item.id), user);
    drafts.push({
      actionItemId: item.id,
      title: item.title,
      resourceId: repo.id,
      connectionId: repo.connection_id,
      target: { resourceId: repo.id, repo: repo.metadata.fullName ?? repo.name },
      targetLabel: `GitHub ${repo.metadata.fullName ?? repo.name}`,
      payload: { itemIds: [item.id], repo: repo.metadata.fullName ?? repo.name, title: short(item.title, 250), body, assignees: login ? [login] : [] },
      affectedUserIds: item.assignee ? [item.assignee.id] : [],
      preview: { title: short(item.title, 250), body, assignee: login },
      ...(problem ? { blockers: [problem] } : {}),
      warnings: item.assignee && !login ? [`${item.assignee.fullName} has no linked GitHub account: the issue is unassigned`] : [],
    });
  }
  return { drafts, summary: `Create ${drafts.length} GitHub issue${drafts.length === 1 ? '' : 's'}`, warnings: ['WorkAgent creates issues and comments only; it never commits or changes code'] };
}

async function planGithubComment(user, items, { text }) {
  if (!text || !String(text).trim()) throw badRequest('Write the comment text', [{ field: 'text', message: 'Required' }]);
  const drafts = [];
  for (const item of items) {
    const [rec] = await linkedRecords(item.id, 'github', ['issue', 'pull_request']);
    if (!rec) {
      drafts.push({ actionItemId: item.id, title: item.title, ...blocker('No GitHub issue or pull request is linked to this item'), payload: {} });
      continue;
    }
    const problem = await githubWriteProblem(rec.connection_id);
    const repo = String(rec.external_key ?? '').split('#')[0];
    const body = commentBody(item, String(text).trim().slice(0, 5000), user);
    drafts.push({ actionItemId: item.id, title: item.title, resourceId: rec.resource_id, connectionId: rec.connection_id, target: { recordId: rec.id, repo, number: rec.metadata.number }, targetLabel: `GitHub ${rec.external_key}`, payload: { itemIds: [item.id], body }, preview: { comment: body }, ...(problem ? { blockers: [problem] } : {}) });
  }
  return { drafts, summary: `Comment on ${drafts.length} GitHub item${drafts.length === 1 ? '' : 's'}` };
}

// ---- calendar ---------------------------------------------------------------------------------------

async function planCalendar(user, items, options) {
  const attendees = { userIds: [...new Set([...(options.attendees?.userIds ?? []), ...items.map((i) => i.assignee?.id).filter(Boolean)])], groupIds: options.attendees?.groupIds ?? [] };
  const input = {
    title: options.title ?? (items.length === 1 ? `Follow-up: ${items[0].title}` : null),
    startAt: options.startAt,
    durationMinutes: Number(options.durationMinutes ?? 30),
    timeZone: options.timeZone,
    provider: options.provider ?? 'workagent',
    connectionId: options.connectionId ?? null,
    projectId: options.projectId ?? items[0]?.projectId ?? null,
    attendees,
    excludedUserIds: options.excludedUserIds ?? [],
  };
  if (!input.title || !input.startAt || !input.timeZone) throw badRequest('Give the meeting title, start and time zone', [{ field: 'startAt', message: 'Required' }]);
  const p = await previewMeeting(user, input);
  const blockers = [...(p.calendar.canWrite ? [] : [p.calendar.problem]), ...(p.total === 0 ? ['Nobody would be invited'] : [])];
  return {
    provider: 'calendar',
    providerLabel: p.calendar.provider === 'workagent' ? 'WorkAgent invitations' : p.calendar.provider === 'outlook' ? 'Outlook / Teams' : 'Google Calendar',
    drafts: [{
      title: input.title,
      target: { provider: p.calendar.provider, connectionId: p.calendar.connectionId ?? null },
      targetLabel: p.calendar.label ?? p.calendar.provider,
      payload: { itemIds: items.map((i) => i.id), input: { ...input, provider: p.calendar.provider }, recipientsHash: p.recipientsHash },
      affectedUserIds: p.invitees.map((i) => i.id),
      preview: { title: input.title, start: p.meeting.startAt, end: p.meeting.endAt, timeZone: input.timeZone, invitees: p.invitees.map((i) => ({ name: i.fullName ?? i.name, email: i.email, via: i.via })), conflicts: p.availability.conflicts ?? [] },
    }],
    recipients: p.invitees.map((i) => ({ userId: i.id, name: i.fullName ?? i.name, email: i.email, via: i.via })),
    blockers,
    warnings: p.warnings,
    summary: `Schedule “${input.title}” with ${p.total} people`,
  };
}

// ---- in-app ---------------------------------------------------------------------------------------

async function planNotify(user, items, { template = 'assignment', note = null }) {
  const drafts = items.map((item) =>
    item.assignee
      ? { actionItemId: item.id, title: item.title, target: { userId: item.assignee.id }, targetLabel: item.assignee.fullName, payload: { itemIds: [item.id], userId: item.assignee.id, template, note, title: `${user.fullName}: ${short(item.title, 200)}` }, affectedUserIds: [item.assignee.id], preview: { to: item.assignee.fullName, message: note ?? item.title } }
      : { actionItemId: item.id, title: item.title, skip: { reason: 'No owner' }, payload: {} },
  );
  return { drafts, summary: `Notify ${drafts.filter((d) => !d.skip).length} owner(s) in WorkAgent` };
}

export const PLANNERS = {
  'jira.create_issue': planJiraCreate,
  'jira.comment': planJiraComment,
  'jira.update': planJiraUpdate,
  'jira.transition': planJiraTransition,
  'jira.link': planJiraLink,
  'email.send': planEmail,
  'teams.message': planTeams,
  'github.create_issue': planGithubIssue,
  'github.comment': planGithubComment,
  'calendar.schedule': planCalendar,
  'workagent.notify': planNotify,

  /** Targets a person can choose for a kind (Jira projects, repositories, Teams channels). */
  async targets(kind) {
    const pick = { 'jira.create_issue': ['jira', 'project'], 'github.create_issue': ['github', 'repository'], 'teams.message': ['microsoft_teams', 'channel'] }[kind];
    if (!pick) return [];
    return (await activeResources(...pick)).map((r) => ({ id: r.id, name: r.metadata?.key ? `${r.metadata.key} · ${r.name}` : r.name, projectId: r.project_id, mock: Boolean(r.metadata?.isMock) }));
  },

  /** Why a kind is unavailable for this person now, or null. */
  async availability(kind, user) {
    if (kind.startsWith('jira.')) return jiraAvailability(user);
    if (kind === 'email.send') return email.isConfigured() ? null : `E-mail is not configured (${email.configurationProblem()})`;
    if (kind === 'teams.message') return registry.getAvailable('microsoft_teams') ? ((await activeResources('microsoft_teams', 'channel')).length ? null : 'No Teams channel is enabled') : `Microsoft Teams is not available: ${registry.problem('microsoft_teams')}`;
    if (kind.startsWith('github.')) {
      const repos = await activeResources('github', 'repository');
      return repos.length ? githubWriteProblem(repos[0].connection_id) : 'No GitHub repository is connected';
    }
    return null;
  },

  /** Approval-time checks with the approver's own provider rights. Throws AppError. */
  async check(kind, user, execs) {
    if (kind === 'jira.create_issue' || kind.startsWith('jira.')) {
      const perms = { 'jira.create_issue': ['CREATE_ISSUES'], 'jira.comment': ['ADD_COMMENTS'], 'jira.update': ['EDIT_ISSUES'], 'jira.transition': ['TRANSITION_ISSUES'], 'jira.link': ['LINK_ISSUES'] }[kind];
      for (const resourceId of new Set(execs.map((x) => x.resource_id).filter(Boolean))) {
        const j = await jiraContext(resourceId);
        const assigns = kind === 'jira.create_issue' && execs.some((x) => x.resource_id === resourceId && x.payload?.assigneeAccountId);
        await assertJiraPermissions(j, user.id, [...perms, ...(assigns ? ['ASSIGN_ISSUES'] : [])]);
      }
    }
    if (kind === 'email.send' && !email.isConfigured()) throw new AppError(409, 'EMAIL_NOT_CONFIGURED', `E-mail sending is not configured (${email.configurationProblem()})`);
    if (kind.startsWith('github.')) {
      for (const cid of new Set(execs.map((x) => x.connection_id).filter(Boolean))) {
        const problem = await githubWriteProblem(cid);
        if (problem) throw new AppError(409, 'GITHUB_READ_ONLY', problem);
      }
    }
  },
};
