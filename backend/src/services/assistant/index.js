// Conversational task and meeting orchestration (Feature 3).
//
//   message ──▶ WorkAPI (closed intent set, strict JSON schema) ──▶ parser.js (grounding, dates)
//           ──▶ resolver.js (people, groups, meetings, tasks, Jira projects; choices when ambiguous)
//           ──▶ plan (the confirmation card)  ──confirm──▶ executor.js (Jira / calendar / WorkAgent)
//           ──▶ work graph (ingested issue, scheduled meeting, audited task change) ──▶ undo window
//
// Every step is stored on command_invocations (utterance, parse, resolution, plan, confirming user,
// result, provider, external id, timestamps) and audited. Nothing is written anywhere before the
// person confirms; query_status is read-only and answers directly.
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { localDate, addDays } from '../../utils/dates.js';
import { audit } from '../audit.js';
import { getPreferences } from '../notifications/inbox.js';
import { isAdmin, MANAGER_ROLES } from '../permissions.js';
import { accessScope, canManageProjectId, taskVisibilitySql } from '../records/access.js';
import { calendarOptions, wallClock } from '../scheduling/calendars.js';
import { previewMeeting } from '../scheduling/index.js';
import { speechInfo } from '../speech/index.js';
import { workapi } from '../workapi/index.js';
import { execute, jiraAccountOf, jiraContext, TASK_PRIORITY, undo as undoExecution } from './executor.js';
import { buildSystemPrompt, buildUserMessage, COMMAND_SCHEMA, normalizeParse, PROMPT_VERSION, resolveDue, resolveStart } from './parser.js';
import { resolveAttendee, resolveJiraTarget, resolvePastMeeting, resolvePerson, resolveTask, teamMembers } from './resolver.js';
import { answerWorkQuery, planActions } from './work.js';
import * as engine from '../execution/index.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
const PROVIDER_OF = { outlook: 'outlook', google: 'google_calendar', workagent: 'workagent' };
const DEFAULT_MEETING_TZ = () => config.features.orgTimeZone;

const toCommand = (r) => ({
  id: r.id,
  conversationId: r.conversation_id,
  userId: r.user_id,
  utterance: r.utterance,
  inputMode: r.input_mode,
  intent: r.intent,
  slots: parse(r.slots),
  resolution: parse(r.resolution),
  plan: parse(r.plan),
  status: r.status,
  clarification: r.clarification,
  provider: r.provider,
  externalKey: r.external_key,
  externalUrl: r.external_url,
  externalRecordId: r.external_record_id,
  meetingId: r.meeting_id,
  actionItemId: r.action_item_id,
  undoDeadline: r.undo_deadline,
  canUndo: Boolean(parse(r.undo_data)) && r.status === 'executed' && r.undo_deadline && new Date(r.undo_deadline) > new Date(),
  undoneAt: r.undone_at,
  result: parse(r.result),
  error: r.error,
  aiProvider: r.ai_provider,
  aiModel: r.ai_model,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  executedAt: r.executed_at,
  createdAt: r.created_at,
});

async function loadCommand(user, id, { forUpdate = false, conn = pool } = {}) {
  const [[r]] = await conn.query(`SELECT * FROM command_invocations WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  // Commands are private to the person who gave them.
  if (!r || r.user_id !== user.id) throw notFound('Command not found');
  return r;
}

async function saveCommand(id, fields) {
  const cols = { intent: 'intent', slots: 'slots', resolution: 'resolution', plan: 'plan', status: 'status', clarification: 'clarification', provider: 'provider', externalId: 'external_id', externalKey: 'external_key', externalUrl: 'external_url', externalRecordId: 'external_record_id', meetingId: 'meeting_id', actionItemId: 'action_item_id', undoData: 'undo_data', undoDeadline: 'undo_deadline', undoneAt: 'undone_at', undoneBy: 'undone_by', result: 'result', error: 'error', aiProvider: 'ai_provider', aiModel: 'ai_model', confirmedBy: 'confirmed_by', confirmedAt: 'confirmed_at', executedAt: 'executed_at', utterance: 'utterance' };
  const json = new Set(['slots', 'resolution', 'plan', 'undoData', 'result']);
  const entries = Object.entries(fields).filter(([k, v]) => cols[k] && v !== undefined);
  if (!entries.length) return;
  await pool.execute(`UPDATE command_invocations SET ${entries.map(([k]) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`, [...entries.map(([k, v]) => (json.has(k) && v !== null ? JSON.stringify(v) : v)), id]);
}

async function say(conversationId, content, commandId = null) {
  await pool.execute("INSERT INTO assistant_messages (conversation_id, role, content, command_id) VALUES (?, 'assistant', ?, ?)", [conversationId, String(content).slice(0, 5000), commandId]);
}

async function userTimeZone(user) {
  return (await getPreferences(user.id)).timeZone ?? DEFAULT_MEETING_TZ();
}

// ---- capabilities / conversations -----------------------------------------------------------------

export async function capabilities(user) {
  const calendars = await calendarOptions(user);
  return {
    ai: { configured: workapi.isConfigured(), provider: workapi.provider(), model: workapi.model() },
    speech: speechInfo(),
    intents: ['create_meeting', 'assign_task', 'update_task', 'set_deadline', 'query_status', 'query_work', 'act_on_actions'],
    undoSeconds: config.features.assistantUndoSeconds,
    calendars,
    timeZone: await userTimeZone(user),
  };
}

export async function listConversations(user) {
  const [rows] = await pool.query('SELECT id, title, created_at, updated_at FROM assistant_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [user.id]);
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export async function getConversation(user, id) {
  const [[c]] = await pool.query('SELECT * FROM assistant_conversations WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!c) throw notFound('Conversation not found');
  const [messages] = await pool.query('SELECT id, role, content, input_mode, command_id, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY id', [id]);
  const [commands] = await pool.query('SELECT * FROM command_invocations WHERE conversation_id = ? ORDER BY id', [id]);
  return {
    conversation: { id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at },
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, inputMode: m.input_mode, commandId: m.command_id, createdAt: m.created_at })),
    commands: commands.map(toCommand),
  };
}

export async function deleteConversation(user, id) {
  const [r] = await pool.execute('DELETE FROM assistant_conversations WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!r.affectedRows) throw notFound('Conversation not found');
}

// ---- resolution and plans -------------------------------------------------------------------------

/**
 * Resolves the slots of a parsed command into WorkAgent entities and a confirmation plan.
 * `chosen` holds the person's earlier picks ({ slotKey: optionId }) so a choice is never asked twice.
 * Returns { resolved, pending: [{ key, reason, options }], errors: [string], plan|null }.
 */
async function resolveCommand(user, intent, slots, chosen, { now, timeZone }) {
  const resolved = {};
  const pending = [];
  const errors = [];
  const pick = (key, res, mapOption) => {
    if (chosen[key] !== undefined) {
      const opt = (res.choices ?? []).find((o) => String(o.id) === String(chosen[key]) || o.value === chosen[key]);
      if (opt) return mapOption(opt);
    }
    if (res.choices) {
      pending.push({ key, reason: res.reason, options: res.choices.map((o) => ({ id: o.id ?? o.value, label: o.label, detail: o.detail ?? null, kind: o.kind ?? null })) });
      return undefined;
    }
    if (res.error) {
      errors.push(res.error);
      return undefined;
    }
    return res;
  };
  const today = localDate(now, timeZone);
  const dateChoice = (res) => (res.choices ? { choices: res.choices.map((d) => ({ id: d, value: d, label: d })), reason: res.reason } : res);

  if (slots.due_date_text) {
    const due = resolveDue(slots.due_date_text, slots.due_date, today);
    if (due.ambiguous) errors.push(`${due.reason}. Please give the date (for example 20 November).`);
    else {
      const r = pick('due', dateChoice(due), (o) => ({ date: o.value ?? o.id }));
      if (r) resolved.due = { date: r.date, flagged: Boolean(due.flagged) };
    }
  }
  if (slots.assignee && intent !== 'create_meeting' && intent !== 'query_status') {
    const r = pick('assignee', await resolvePerson(slots.assignee), (o) => ({ userId: Number(o.id), label: o.label }));
    if (r) resolved.assignee = { userId: r.userId, label: r.label };
  }

  if (intent === 'create_meeting') {
    if (slots.start_text) {
      const st = resolveStart(slots.start_text, slots.start_datetime, { now, timeZone });
      if (st.ambiguous) errors.push(`${st.reason} Please say the day and time again.`);
      else {
        const label = (iso) => `${wallClock(iso, timeZone).replace('T', ' ').slice(0, 16)} (${timeZone})`;
        const r = pick('start', st.choices ? { choices: st.choices.map((iso) => ({ id: iso, value: iso, label: label(iso) })), reason: st.reason } : st, (o) => ({ startAt: o.value ?? o.id }));
        if (r) resolved.start = { startAt: r.startAt, flagged: Boolean(st.flagged), label: label(r.startAt) };
      }
    }
    const userIds = new Set();
    const groupIds = new Set();
    const labels = [];
    for (const [i, phrase] of slots.attendees.entries()) {
      const r = pick(`attendee:${i}`, await resolveAttendee(user, phrase), (o) => o);
      if (!r) continue;
      if (r.kind === 'group') groupIds.add(Number(r.id));
      else if (r.kind === 'team') {
        for (const u of r.userIds ?? (await teamMembers(Number(r.id)))) userIds.add(u);
      } else userIds.add(Number(r.id));
      labels.push(r.label);
    }
    if (slots.attendees_from_meeting) {
      const res = await resolvePastMeeting(user, slots.attendees_from_meeting, { now, timeZone });
      const r = pick('pastMeeting', res, (o) => ({ meetingId: Number(o.id), label: o.label }));
      if (r) {
        const ids = r.userIds ?? (await pool.query('SELECT user_id FROM meeting_participants WHERE meeting_id = ?', [r.meetingId]))[0].map((x) => x.user_id);
        for (const u of ids) userIds.add(u);
        labels.push(`everyone in “${r.label}”`);
      }
    }
    resolved.attendees = { userIds: [...userIds], groupIds: [...groupIds], labels };
    if (slots.calendar_provider) {
      const provider = PROVIDER_OF[slots.calendar_provider];
      const opts = (await calendarOptions(user)).filter((o) => o.provider === provider && o.canWrite);
      if (!opts.length) errors.push(provider === 'workagent' ? '' : `You have no ${provider === 'outlook' ? 'Outlook' : 'Google'} calendar connected that can send invitations; choose another option on the card.`);
      else resolved.calendar = { provider, connectionId: opts[0].connectionId };
    }
  }

  if (intent === 'assign_task') {
    const r = pick('jiraTarget', await resolveJiraTarget(slots.project), (o) => ({ resourceId: Number(o.id), label: o.label }));
    if (r) resolved.jira = { resourceId: r.resourceId, label: r.label, only: Boolean(r.only) };
  }

  if (intent === 'update_task' || intent === 'set_deadline' || (intent === 'query_status' && slots.query === 'task_status')) {
    if (slots.task_reference) {
      const r = pick('task', await resolveTask(user, slots.task_reference), (o) => ({ ref: { type: o.kind, id: Number(o.id) }, label: o.label }));
      if (r) resolved.task = { ref: r.ref, label: r.label };
    }
  }

  if (intent === 'query_status' && slots.query_person) {
    const r = pick('queryPerson', await resolvePerson(slots.query_person), (o) => ({ userId: Number(o.id), label: o.label }));
    if (r) resolved.queryPerson = { userId: r.userId, label: r.label };
  }

  return { resolved, pending, errors: errors.filter(Boolean) };
}

/** The confirmation card for a fully resolved command. Returns { plan } or { error }. */
async function buildPlan(user, intent, slots, resolved, { timeZone, overrides = {} }) {
  const [[me]] = await pool.query('SELECT full_name FROM users WHERE id = ?', [user.id]);
  const requestedBy = me.full_name;
  if (intent === 'assign_task') {
    const blockers = [];
    const j = await jiraContext(resolved.jira.resourceId).catch((err) => ({ error: err.message }));
    if (j.error) blockers.push(j.error);
    else if (!(await jiraAccountOf(j.connector.sourceInstance, user.id))) blockers.push('Your WorkAgent account is not linked to a Jira account, so WorkAgent cannot act in Jira for you. Ask an admin to link your Jira identity.');
    const assigneeLinked = j.connector ? Boolean(await jiraAccountOf(j.connector.sourceInstance, resolved.assignee.userId)) : false;
    return {
      plan: {
        action: 'jira_create',
        headline: `Create a Jira issue in ${resolved.jira.label} and assign it to ${resolved.assignee.label}`,
        provider: 'jira',
        externalWrite: true,
        requestedBy,
        title: slots.task_title,
        description: slots.description ?? null,
        assignee: resolved.assignee,
        dueDate: resolved.due?.date ?? null,
        priority: slots.priority ?? null,
        jira: resolved.jira,
        fields: [
          { label: 'Title', value: slots.task_title },
          { label: 'Assignee', value: resolved.assignee.label },
          { label: 'Due date', value: resolved.due?.date ?? 'none', flagged: resolved.due?.flagged ?? false },
          { label: 'Priority', value: slots.priority ? `${slots.priority} (Jira: ${({ critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest' })[slots.priority]})` : 'Jira default' },
          { label: 'Jira project', value: resolved.jira.label + (resolved.jira.only ? ' (the only project available)' : '') },
        ],
        affected: [{ userId: resolved.assignee.userId, fullName: resolved.assignee.label, role: 'assignee' }],
        warnings: [
          ...(resolved.due?.flagged ? ['The due date was read by the AI, not by WorkAgent’s date rules: check it.'] : []),
          ...(!assigneeLinked && j.connector ? [`${resolved.assignee.label} has no linked Jira account: the issue will be created unassigned and they will be told in WorkAgent.`] : []),
        ],
        blockers,
        undo: 'Can be undone for a short time if you may delete issues in this Jira project.',
      },
    };
  }

  if (intent === 'update_task' || intent === 'set_deadline') {
    const task = resolved.task;
    const changes = {};
    const fields = [{ label: 'Task', value: task.label }];
    const warnings = [];
    const blockers = [];
    if (resolved.due) {
      changes.dueDate = resolved.due.date;
      fields.push({ label: 'Due date', value: resolved.due.date, flagged: resolved.due.flagged });
      if (resolved.due.flagged) warnings.push('The due date was read by the AI, not by WorkAgent’s date rules: check it.');
    }
    if (intent === 'update_task') {
      if (slots.priority) {
        if (task.ref.type === 'action_item') {
          changes.priority = TASK_PRIORITY[slots.priority];
          if (changes.priority !== slots.priority) warnings.push(`WorkAgent tasks have low/medium/high priorities: “${slots.priority}” will be saved as “${changes.priority}”.`);
        } else changes.priority = slots.priority;
        fields.push({ label: 'Priority', value: changes.priority });
      }
      if (resolved.assignee) {
        changes.assigneeUserId = resolved.assignee.userId;
        fields.push({ label: 'Assignee', value: resolved.assignee.label });
      }
      if (slots.status) {
        if (task.ref.type === 'external_record') blockers.push('Changing a Jira issue’s status is not supported from the assistant; change it in Jira.');
        else {
          changes.taskStatus = slots.status;
          fields.push({ label: 'Status', value: slots.status });
        }
      }
    }
    if (!Object.keys(changes).length && !blockers.length) return { error: 'Nothing to change was stated.' };
    let affected = [];
    if (task.ref.type === 'action_item') {
      const [[item]] = await pool.query('SELECT ai.project_id, ai.assignee_user_id, u.full_name FROM action_items ai LEFT JOIN users u ON u.id = ai.assignee_user_id WHERE ai.id = ?', [task.ref.id]);
      const scope = await accessScope(user);
      const manages = isAdmin(user) || canManageProjectId(scope, item?.project_id);
      if (!manages && !(item?.assignee_user_id === user.id && Object.keys(changes).every((k) => k === 'taskStatus'))) blockers.push('Only an admin or the project’s manager can change this task (assignees can change its status).');
      if (item?.assignee_user_id) affected.push({ userId: item.assignee_user_id, fullName: item.full_name, role: 'current assignee' });
    }
    if (resolved.assignee) affected.push({ userId: resolved.assignee.userId, fullName: resolved.assignee.label, role: 'new assignee' });
    return {
      plan: {
        action: 'task_update',
        headline: `Update ${task.ref.type === 'action_item' ? 'WorkAgent task' : 'Jira issue'} “${task.label}”`,
        provider: task.ref.type === 'action_item' ? 'workagent' : 'jira',
        externalWrite: task.ref.type !== 'action_item',
        requestedBy,
        task,
        assignee: resolved.assignee ?? null,
        changes,
        fields,
        affected,
        warnings,
        blockers,
        undo: 'Can be undone for a short time (the previous values are restored).',
      },
    };
  }

  if (intent === 'create_meeting') {
    const calendar = overrides.provider ? { provider: overrides.provider, connectionId: overrides.connectionId ?? null } : resolved.calendar ?? { provider: 'workagent', connectionId: null };
    const meetingInput = {
      title: slots.meeting_title,
      startAt: resolved.start.startAt,
      durationMinutes: slots.duration_minutes,
      timeZone,
      provider: calendar.provider,
      connectionId: calendar.connectionId,
      attendees: { userIds: resolved.attendees.userIds, groupIds: resolved.attendees.groupIds },
      excludedUserIds: overrides.excludedUserIds ?? [],
    };
    let preview;
    try {
      preview = await previewMeeting(user, meetingInput);
    } catch (err) {
      return { error: err.message };
    }
    return {
      plan: {
        action: 'meeting_create',
        headline: `Schedule “${slots.meeting_title}” on ${resolved.start.label} for ${slots.duration_minutes} minutes`,
        provider: calendar.provider,
        externalWrite: calendar.provider !== 'workagent',
        requestedBy,
        meetingInput,
        recipientsHash: preview.recipientsHash,
        recipientCount: preview.total,
        requiresLargeConfirmation: preview.requiresLargeConfirmation,
        invitees: preview.invitees.map((p) => ({ id: p.id, fullName: p.fullName, via: p.via })),
        excluded: preview.excluded,
        groups: preview.groups.map(({ memberIds, ...g }) => g),
        availability: preview.availability,
        calendars: await calendarOptions(user),
        fields: [
          { label: 'Title', value: slots.meeting_title },
          { label: 'When', value: resolved.start.label, flagged: resolved.start.flagged },
          { label: 'Duration', value: `${slots.duration_minutes} minutes` },
          { label: 'Attendees', value: `${preview.total} (${resolved.attendees.labels.join(', ')})` },
          { label: 'Calendar', value: preview.calendar.label },
        ],
        affected: preview.invitees.map((p) => ({ userId: p.id, fullName: p.fullName, role: 'invitee' })),
        warnings: [
          ...preview.warnings,
          ...(resolved.start.flagged ? ['The time was read by the AI, not by WorkAgent’s date rules: check it.'] : []),
          ...(preview.availability.conflicts.length ? [`${preview.availability.conflicts.length} invitee(s) are busy then.`] : []),
        ],
        blockers: preview.calendar.canWrite ? [] : [preview.calendar.problem],
        undo: 'Can be undone for a short time (the meeting is cancelled; if invitations already went out, attendees get a cancellation).',
      },
    };
  }
  return { error: 'Unsupported command' };
}

// ---- query_status (read-only) ---------------------------------------------------------------------

async function answerQuery(user, slots, resolved, { now, timeZone }) {
  const target = resolved.queryPerson ?? null;
  if (target && target.userId !== user.id && !MANAGER_ROLES.includes(user.role)) return { text: 'You can ask about your own tasks; managers and admins can ask about others in their projects.', items: [] };
  const who = target?.userId ?? user.id;
  const scope = await accessScope(user);
  const vis = taskVisibilitySql(scope);
  const today = localDate(now, timeZone);
  const where = ['ai.review_status = \'approved\'', 'ai.assignee_user_id = ?'];
  const params = [who];
  const q = slots.query;
  if (q === 'task_status' && resolved.task) {
    if (resolved.task.ref.type === 'external_record') {
      const [[r]] = await pool.query('SELECT id, external_key, title, state, status_category, url, metadata FROM external_records WHERE id = ?', [resolved.task.ref.id]);
      const due = parse(r.metadata)?.dueDate;
      return { text: `${r.external_key} “${r.title}” is ${r.state ?? r.status_category}${due ? `, due ${due}` : ''}.`, items: [{ ref: { type: 'external_record', id: r.id }, title: `${r.external_key} ${r.title}`, status: r.state, dueDate: due ?? null, url: `/records/${r.id}` }] };
    }
    where.splice(1, 1);
    params.splice(0, 1);
    where.push('ai.id = ?');
    params.push(resolved.task.ref.id);
  } else if (q === 'overdue_tasks') {
    where.push("ai.task_status <> 'done' AND ai.due_date < ?");
    params.push(today);
  } else if (q === 'due_soon') {
    where.push("ai.task_status <> 'done' AND ai.due_date BETWEEN ? AND ?");
    params.push(today, addDays(today, 7));
  } else if (q === 'blocked_tasks') where.push("ai.task_status = 'blocked'");
  else where.push("ai.task_status <> 'done'");
  const [rows] = await pool.query(
    `SELECT ai.id, ai.title, ai.task_status, ai.due_date, ai.priority FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id
     WHERE ${where.join(' AND ')}${vis.sql ? ` AND ${vis.sql}` : ''} ORDER BY ai.due_date IS NULL, ai.due_date LIMIT 50`,
    [...params, ...vis.params],
  );
  // Jira issues assigned to the person's linked Jira accounts (visible projects only).
  let issues = [];
  if (q !== 'task_status') {
    const [ids] = await pool.query("SELECT external_user_id FROM external_identities WHERE provider = 'jira' AND user_id = ?", [who]);
    if (ids.length) {
      const projectFilter = scope.admin ? '' : scope.visible.length ? ' AND r.project_id IN (?)' : ' AND FALSE';
      const [recs] = await pool.query(
        `SELECT r.id, r.external_key, r.title, r.state, r.status_category, r.metadata FROM external_records r
         WHERE r.provider = 'jira' AND r.record_type = 'issue' AND r.source_deleted_at IS NULL AND r.status_category <> 'done'${projectFilter} LIMIT 500`,
        scope.admin || !scope.visible.length ? [] : [scope.visible],
      );
      const mine = new Set(ids.map((i) => i.external_user_id));
      issues = recs
        .map((r) => ({ ...r, meta: parse(r.metadata) ?? {} }))
        .filter((r) => (r.meta.assignees ?? []).some((a) => mine.has(a.id)))
        .filter((r) => (q === 'overdue_tasks' ? r.meta.dueDate && r.meta.dueDate < today : q === 'due_soon' ? r.meta.dueDate && r.meta.dueDate >= today && r.meta.dueDate <= addDays(today, 7) : q === 'blocked_tasks' ? /block/i.test(r.state ?? '') : true));
    }
  }
  const iso = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
  const items = [
    ...rows.map((r) => ({ ref: { type: 'action_item', id: r.id }, title: r.title, status: r.task_status, dueDate: iso(r.due_date), priority: r.priority, url: who === user.id ? `/my/tasks/${r.id}` : null, overdueDays: r.due_date && iso(r.due_date) < today && r.task_status !== 'done' ? Math.round((new Date(today) - new Date(iso(r.due_date))) / 86_400_000) : 0 })),
    ...issues.map((r) => ({ ref: { type: 'external_record', id: r.id }, title: `${r.external_key} ${r.title ?? ''}`.trim(), status: r.state, dueDate: r.meta.dueDate ?? null, url: `/records/${r.id}` })),
  ];
  const whoLabel = target && target.userId !== user.id ? target.label : 'you';
  const what = { overdue_tasks: 'overdue', due_soon: 'due in the next 7 days', blocked_tasks: 'blocked', my_tasks: 'open', task_status: '' }[q] ?? 'open';
  const text = q === 'task_status' ? (items[0] ? `“${items[0].title}” is ${items[0].status}${items[0].dueDate ? `, due ${items[0].dueDate}` : ''}.` : 'I could not find that task.') : items.length ? `${items.length} ${what} task${items.length === 1 ? '' : 's'} for ${whoLabel}.` : `No ${what} tasks for ${whoLabel}.`;
  return { text, items };
}

/** Confirming an engine plan = approving it with the previewed hash; the cancel window is the undo. */
async function approveEnginePlan(user, plan, largeConfirmed, ip) {
  if (!plan.engine?.planId) throw new AppError(409, 'COMMAND_BLOCKED', 'Nothing can be executed as asked');
  const out = await engine.approve(user, plan.engine.planId, { previewHash: plan.engine.previewHash, largeConfirmed }, { ip });
  const n = out.plan.executions.length;
  const until = out.cancelUntil ? new Date(out.cancelUntil) : null;
  return {
    provider: plan.provider,
    summary: `Approved: ${n} action${n === 1 ? '' : 's'} (${plan.providerLabel}). ${until ? `They run after the ${Math.round((until - Date.now()) / 1000)}-second cancel window` : 'They run now'}; progress is on the Approvals page.`,
    undo: until ? { kind: 'engine_cancel', planId: plan.engine.planId } : null,
    undoDeadline: until,
    undoSeconds: until ? Math.max(1, Math.round((until - Date.now()) / 1000)) : 0,
    externalKey: `plan:${plan.engine.planId}`,
  };
}

// ---- the conversation step ------------------------------------------------------------------------

const UNSUPPORTED = 'I can schedule meetings, assign or update tasks, set deadlines, answer questions about tasks and the work graph (action items, commitments, blockers, progress, design changes), and act on action items (Jira issues, e-mail, notifications, Teams, summaries). I can’t do that one.';

async function advance(user, cmdRow, { now = new Date(), overrides } = {}) {
  const intent = cmdRow.intent;
  const slots = parse(cmdRow.slots);
  const prior = parse(cmdRow.resolution) ?? {};
  const chosen = prior.chosen ?? {};
  const timeZone = await userTimeZone(user);
  const { resolved, pending, errors } = await resolveCommand(user, intent, slots, chosen, { now, timeZone });
  const resolution = { chosen, resolved, pending, errors, timeZone };
  if (errors.length || pending.length) {
    const question = errors.length ? errors.join(' ') : pending[0].reason;
    await saveCommand(cmdRow.id, { resolution, status: 'needs_clarification', clarification: question, plan: null });
    await say(cmdRow.conversation_id, question, cmdRow.id);
    return;
  }
  // Work-graph intents (services/assistant/work.js): a choice, a question, an answer or an engine plan.
  if (intent === 'query_work' || intent === 'act_on_actions') {
    const ctx = { now, timeZone, chosen };
    const out = intent === 'query_work' ? await answerWorkQuery(user, slots, ctx) : await planActions(user, slots, ctx, cmdRow.id);
    if (out.choices) {
      const pendingChoice = { key: out.key, reason: out.reason, options: out.choices.map((o) => ({ id: o.id, label: o.label, detail: o.detail ?? null, kind: o.kind ?? null })) };
      await saveCommand(cmdRow.id, { resolution: { ...resolution, pending: [pendingChoice] }, status: 'needs_clarification', clarification: out.reason, plan: null });
      await say(cmdRow.conversation_id, out.reason, cmdRow.id);
      return;
    }
    if (out.error) {
      await saveCommand(cmdRow.id, { resolution, status: 'needs_clarification', clarification: out.error, plan: null });
      await say(cmdRow.conversation_id, out.error, cmdRow.id);
      return;
    }
    if (intent === 'query_work') {
      await saveCommand(cmdRow.id, { resolution, status: 'answered', result: out, clarification: null });
      await say(cmdRow.conversation_id, out.text, cmdRow.id);
      return;
    }
    await saveCommand(cmdRow.id, { resolution, plan: out.plan, status: 'awaiting_confirmation', clarification: null });
    await say(cmdRow.conversation_id, `${out.plan.headline}. Review every recipient and message, then confirm — nothing is sent or created until you do.`, cmdRow.id);
    return;
  }
  if (intent === 'query_status') {
    const answer = await answerQuery(user, slots, resolved, { now, timeZone });
    await saveCommand(cmdRow.id, { resolution, status: 'answered', result: answer, clarification: null });
    await say(cmdRow.conversation_id, answer.text, cmdRow.id);
    return;
  }
  const { plan, error } = await buildPlan(user, intent, slots, resolved, { timeZone, overrides });
  if (error) {
    await saveCommand(cmdRow.id, { resolution, status: 'needs_clarification', clarification: error });
    await say(cmdRow.conversation_id, error, cmdRow.id);
    return;
  }
  await saveCommand(cmdRow.id, { resolution, plan, status: 'awaiting_confirmation', clarification: null });
  await say(cmdRow.conversation_id, `${plan.headline}. Check the details and confirm — nothing happens until you do.`, cmdRow.id);
}

/**
 * Handles one message from the person. A message after a clarification question continues that
 * command; otherwise it starts a new one. Returns the conversation.
 */
export async function handleMessage(user, { conversationId = null, text, inputMode = 'text' }, { ip = null, now = new Date() } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw badRequest('Say or type a request');
  let convId = conversationId;
  if (convId) {
    const [[c]] = await pool.query('SELECT id FROM assistant_conversations WHERE id = ? AND user_id = ?', [convId, user.id]);
    if (!c) throw notFound('Conversation not found');
  } else {
    const [r] = await pool.execute('INSERT INTO assistant_conversations (user_id, title) VALUES (?, ?)', [user.id, clean.slice(0, 80)]);
    convId = r.insertId;
  }
  await pool.execute('UPDATE assistant_conversations SET updated_at = NOW() WHERE id = ?', [convId]);
  const [[open]] = await pool.query("SELECT * FROM command_invocations WHERE conversation_id = ? AND status = 'needs_clarification' ORDER BY id DESC LIMIT 1", [convId]);
  const [msg] = await pool.execute("INSERT INTO assistant_messages (conversation_id, role, content, input_mode) VALUES (?, 'user', ?, ?)", [convId, clean.slice(0, 5000), inputMode]);

  if (!workapi.isConfigured()) {
    await say(convId, 'The AI service is not configured on this server (WorkAPI), so I can’t understand requests yet. Nothing was changed.');
    return getConversation(user, convId);
  }

  // Continue a command that asked a question, or start a new one.
  let cmdId;
  let utterance;
  let previous = null;
  if (open) {
    cmdId = open.id;
    utterance = `${open.utterance}\n${clean}`;
    previous = { utterance: open.utterance, question: open.clarification };
  } else {
    const [r] = await pool.execute("INSERT INTO command_invocations (conversation_id, user_id, utterance, input_mode, status) VALUES (?, ?, ?, ?, 'needs_clarification')", [convId, user.id, clean.slice(0, 5000), inputMode]);
    cmdId = r.insertId;
    utterance = clean;
  }
  await pool.execute('UPDATE assistant_messages SET command_id = ? WHERE id = ?', [cmdId, msg.insertId]);

  const timeZone = await userTimeZone(user);
  let response;
  try {
    response = await workapi.generateJson({ system: buildSystemPrompt(), user: buildUserMessage({ text: clean, now, timeZone, previous }), schema: COMMAND_SCHEMA, purpose: 'assistant.parse', maxOutputTokens: 4096 });
  } catch (err) {
    logger.warn('assistant parse failed', { commandId: cmdId, kind: err.kind ?? err.name });
    await saveCommand(cmdId, { utterance, status: 'failed', error: err.publicMessage ?? 'The AI service failed' });
    await say(convId, `I couldn’t process that right now (${err.publicMessage ?? 'AI service error'}). Nothing was changed.`, cmdId);
    return getConversation(user, convId);
  }
  const parsed = normalizeParse(response.data, utterance);
  const prior = open ? parse(open.resolution) ?? {} : {};
  await saveCommand(cmdId, { utterance, intent: parsed.intent, slots: parsed.slots, aiProvider: response.provider, aiModel: String(response.model ?? '').slice(0, 128), resolution: { chosen: prior.chosen ?? {}, promptVersion: PROMPT_VERSION, dropped: parsed.dropped } });
  if (parsed.intent === 'unsupported') {
    await saveCommand(cmdId, { status: 'rejected', clarification: null });
    await say(convId, UNSUPPORTED, cmdId);
  } else if (parsed.missing.length) {
    await saveCommand(cmdId, { status: 'needs_clarification', clarification: parsed.question });
    await say(convId, parsed.question, cmdId);
  } else {
    await advance(user, await loadCommand(user, cmdId), { now });
  }
  await audit({ actorUserId: user.id, action: 'assistant.command_parsed', entityType: 'command', entityId: cmdId, after: { intent: parsed.intent, missing: parsed.missing, inputMode, provider: response.provider, model: response.model }, ip });
  return getConversation(user, convId);
}

/** The person picked an option for an ambiguous slot. */
export async function choose(user, commandId, { key, optionId }, { now = new Date() } = {}) {
  const row = await loadCommand(user, commandId);
  if (row.status !== 'needs_clarification') throw conflict('This command is not waiting for a choice');
  const resolution = parse(row.resolution) ?? {};
  const pending = (resolution.pending ?? []).find((p) => p.key === key);
  if (!pending || !pending.options.some((o) => String(o.id) === String(optionId))) throw badRequest('Not one of the offered choices');
  await saveCommand(row.id, { resolution: { ...resolution, chosen: { ...(resolution.chosen ?? {}), [key]: optionId } } });
  await pool.execute("INSERT INTO assistant_messages (conversation_id, role, content, command_id) VALUES (?, 'user', ?, ?)", [row.conversation_id, `Chose: ${pending.options.find((o) => String(o.id) === String(optionId)).label}`, row.id]);
  await advance(user, await loadCommand(user, commandId), { now });
  return getConversation(user, row.conversation_id);
}

/** Changes card options before confirming (meeting calendar, exclusions) and rebuilds the plan. */
export async function revise(user, commandId, overrides, { now = new Date() } = {}) {
  const row = await loadCommand(user, commandId);
  if (row.status !== 'awaiting_confirmation' || row.intent !== 'create_meeting') throw conflict('Only a meeting waiting for confirmation can be changed here');
  await advance(user, row, { now, overrides });
  return getConversation(user, row.conversation_id);
}

/** Executes after explicit confirmation. Exactly once: the status moves atomically. */
export async function confirm(user, commandId, { largeConfirmed = false } = {}, { ip = null } = {}) {
  const row = await loadCommand(user, commandId);
  const plan = parse(row.plan);
  if (row.status !== 'awaiting_confirmation' || !plan) throw conflict('This command is not waiting for confirmation');
  if (plan.blockers?.length) throw new AppError(409, 'COMMAND_BLOCKED', plan.blockers.join(' '));
  if (plan.requiresLargeConfirmation && !largeConfirmed) throw new AppError(409, 'LARGE_CONFIRMATION_REQUIRED', `This invites ${plan.recipientCount} people. Confirm the large invitation explicitly.`);
  const [claim] = await pool.execute("UPDATE command_invocations SET status = 'executing', confirmed_by = ?, confirmed_at = NOW() WHERE id = ? AND status = 'awaiting_confirmation'", [user.id, row.id]);
  if (!claim.affectedRows) throw conflict('This command is already being executed');
  let result;
  try {
    result = plan.action === 'engine_plan' ? await approveEnginePlan(user, plan, largeConfirmed, ip) : await execute(user, toCommand(row), { ...plan, largeConfirmed }, { ip });
  } catch (err) {
    const message = err.message ?? 'Execution failed';
    const retryable = err.code === 'RECIPIENTS_CHANGED';
    await saveCommand(row.id, { status: retryable ? 'awaiting_confirmation' : 'failed', error: message.slice(0, 1000) });
    await say(row.conversation_id, `Not done: ${message}`, row.id);
    await audit({ actorUserId: user.id, action: 'assistant.command_failed', entityType: 'command', entityId: row.id, after: { intent: row.intent, error: message.slice(0, 500) }, ip });
    if (retryable) await advance(user, await loadCommand(user, row.id));
    throw err;
  }
  const undoSeconds = result.undoSeconds ?? config.features.assistantUndoSeconds;
  const undoDeadline = result.undoDeadline ?? (result.undo && undoSeconds > 0 ? new Date(Date.now() + undoSeconds * 1000) : null);
  await saveCommand(row.id, {
    status: 'executed',
    provider: result.provider,
    externalId: result.externalId ?? null,
    externalKey: result.externalKey ?? null,
    externalUrl: result.externalUrl ?? null,
    externalRecordId: result.externalRecordId ?? null,
    meetingId: result.meetingId ?? null,
    actionItemId: result.actionItemId ?? null,
    undoData: result.undo ?? null,
    undoDeadline,
    executedAt: new Date(),
    result: { summary: result.summary, undoUnavailable: result.undoUnavailable ?? null },
    error: null,
  });
  await say(row.conversation_id, `${result.summary}${undoDeadline ? ` You can undo this for ${undoSeconds} seconds.` : result.undoUnavailable ? ` ${result.undoUnavailable}` : ''}`, row.id);
  await audit({
    actorUserId: user.id,
    action: 'assistant.command_executed',
    entityType: 'command',
    entityId: row.id,
    after: { utterance: row.utterance, intent: row.intent, slots: parse(row.slots), confirmedBy: user.id, provider: result.provider, externalKey: result.externalKey ?? null, externalId: result.externalId ?? null, meetingId: result.meetingId ?? null, actionItemId: result.actionItemId ?? null },
    ip,
  });
  return getConversation(user, row.conversation_id);
}

export async function cancel(user, commandId, { ip = null } = {}) {
  const row = await loadCommand(user, commandId);
  if (!['needs_clarification', 'awaiting_confirmation'].includes(row.status)) throw conflict('Only a command that has not run can be cancelled');
  const plan = parse(row.plan);
  // A prepared engine plan is withdrawn too, so it can't be approved elsewhere later.
  if (plan?.action === 'engine_plan' && plan.engine?.planId) await engine.cancel(user, plan.engine.planId, { ip }).catch(() => {});
  await saveCommand(row.id, { status: 'cancelled' });
  await say(row.conversation_id, 'Cancelled. Nothing was changed.', row.id);
  await audit({ actorUserId: user.id, action: 'assistant.command_cancelled', entityType: 'command', entityId: row.id, ip });
  return getConversation(user, row.conversation_id);
}

/** Undo within the window. Reports failure honestly and keeps the command 'executed' in that case. */
export async function undoCommand(user, commandId, { ip = null } = {}) {
  const row = await loadCommand(user, commandId);
  const undoData = parse(row.undo_data);
  if (row.status !== 'executed' || !undoData) throw conflict('This command cannot be undone');
  if (!row.undo_deadline || new Date(row.undo_deadline) < new Date()) throw new AppError(409, 'UNDO_EXPIRED', 'The undo window has passed');
  const [claim] = await pool.execute("UPDATE command_invocations SET status = 'executing' WHERE id = ? AND status = 'executed'", [row.id]);
  if (!claim.affectedRows) throw conflict('This command is being changed already');
  try {
    // Engine plans: the undo is the plan's cancel window (nothing has been written yet).
    const r = undoData.kind === 'engine_cancel' ? (await engine.cancel(user, undoData.planId, { ip }), { message: 'the plan was cancelled before anything was written.' }) : await undoExecution(user, undoData, { ip });
    await saveCommand(row.id, { status: 'undone', undoneAt: new Date(), undoneBy: user.id });
    await say(row.conversation_id, `Undone: ${r.message}`, row.id);
    await audit({ actorUserId: user.id, action: 'assistant.command_undone', entityType: 'command', entityId: row.id, after: { kind: undoData.kind, message: r.message }, ip });
  } catch (err) {
    await saveCommand(row.id, { status: 'undo_failed', error: String(err.message).slice(0, 1000) });
    await say(row.conversation_id, `Undo failed — the change is still in place: ${err.message}`, row.id);
    await audit({ actorUserId: user.id, action: 'assistant.undo_failed', entityType: 'command', entityId: row.id, after: { kind: undoData.kind, error: String(err.message).slice(0, 500) }, ip });
    throw err;
  }
  return getConversation(user, row.conversation_id);
}

/** Admin audit view of commands. */
export async function listCommands({ limit = 100 } = {}) {
  const [rows] = await pool.query('SELECT c.*, u.full_name FROM command_invocations c JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT ?', [limit]);
  return rows.map((r) => ({ ...toCommand(r), userName: r.full_name }));
}
