// The assistant's work-graph intents (docs/ACTION_INTELLIGENCE.md §Assistant):
//   query_work      read-only answers from the work graph: action items (e.g. from yesterday's
//                   meetings), overdue commitments, blockers of a project, promised vs. actual
//                   progress (linked Jira/GitHub/Figma activity), owners with pending items, design
//                   changes after a meeting. Numbers are counted in code; nothing is written.
//   act_on_actions  a closed set of bulk operations on action items, always as an execution-engine
//                   plan (exact preview, recipients, content) that the person confirms; the plan's
//                   cancel window is the command's undo.
// Every selection goes through the Action Center's visibility rules, so the assistant never sees or
// acts on more than the person could in the UI.
import { pool } from '../../db/pool.js';
import { addDays, localDate } from '../../utils/dates.js';
import * as center from '../actions/center.js';
import { CATEGORY_LABELS } from '../actions/intelligence.js';
import { linkedWork, workStatus } from '../actions/progress.js';
import * as engine from '../execution/index.js';
import { accessScope } from '../records/access.js';
import { toInstant } from '../scheduling/calendars.js';
import { resolveAttendee, resolvePastMeeting } from './resolver.js';

const norm = (s) => String(s ?? '').toLowerCase();

/** Words for an area of work -> categories (or a team). */
const KIND_CATEGORIES = [
  [/\b(engineering|code|coding|backend|frontend|developer|dev|implementation|bug|bugs)\b/, ['code_implementation', 'blocker_resolution', 'review_request']],
  [/\b(design|designs|ux|ui|figma)\b/, ['design_correction']],
  [/\b(review|reviews)\b/, ['review_request']],
  [/\b(follow[- ]?ups?)\b/, ['follow_up']],
  [/\b(communication|announcements?|e-?mails?)\b/, ['communication_required']],
  [/\b(decisions?)\b/, ['decision_implementation']],
  [/\b(blockers?|blocked)\b/, ['blocker_resolution']],
  [/\b(meetings? to schedule|scheduling)\b/, ['meeting_scheduling']],
];

/** [from, to) instants for "yesterday", "today", "this week", "last week", in the person's zone. */
export function periodOf(text, { now, timeZone }) {
  const t = norm(text);
  if (!t) return null;
  const today = localDate(now, timeZone);
  const at = (d) => toInstant(`${d}T00:00:00`, timeZone);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  if (/\byesterday\b/.test(t)) return { from: at(addDays(today, -1)), to: at(today), label: 'yesterday' };
  if (/\btoday|this morning\b/.test(t)) return { from: at(today), to: at(addDays(today, 1)), label: 'today' };
  if (/\blast week\b/.test(t)) return { from: at(addDays(today, -weekday - 7)), to: at(addDays(today, -weekday)), label: 'last week' };
  if (/\bthis week\b/.test(t)) return { from: at(addDays(today, -weekday)), to: at(addDays(today, 1)), label: 'this week' };
  return null;
}

/**
 * Turns the slots into Action Center filters. Returns { filters, label, error?, choices? }.
 */
export async function selectionFilters(user, slots, { now, timeZone, chosen = {} }) {
  const filters = {};
  const label = [];
  const view = { pending: 'all', approved: 'all', overdue: 'overdue', open: 'all', blocked: 'blocked' }[slots.selection] ?? 'all';
  if (slots.selection === 'pending') {
    filters.reviewStatus = 'approved';
    filters.notDone = true;
    label.push('pending');
  }
  if (slots.selection === 'approved') {
    filters.reviewStatus = 'approved';
    label.push('approved');
  }
  if (slots.selection === 'open') filters.notDone = true;
  if (slots.item_kind) {
    const k = norm(slots.item_kind);
    const hit = KIND_CATEGORIES.find(([re]) => re.test(k));
    if (hit) {
      filters.categories = hit[1];
      label.push(slots.item_kind);
    } else {
      const [teams] = await pool.query('SELECT id, name FROM teams WHERE LOWER(name) LIKE ?', [`%${k.replace(/\b(team|the)\b/g, '').trim()}%`]);
      if (teams.length === 1) {
        filters.teamId = teams[0].id;
        label.push(`${teams[0].name} team`);
      } else return { error: `I don’t know which action items “${slots.item_kind}” means. Say a team, or a kind such as engineering or design.` };
    }
  }
  if (slots.project) {
    const scope = await accessScope(user);
    const [rows] = await pool.query("SELECT id, name FROM projects WHERE LOWER(name) LIKE ? AND status <> 'archived'", [`%${norm(slots.project).replace(/\b(the|project)\b/g, '').trim()}%`]);
    const visible = rows.filter((p) => scope.admin || scope.visibleSet.has(p.id));
    if (chosen.project) filters.projectId = Number(chosen.project);
    else if (visible.length === 1) filters.projectId = visible[0].id;
    else if (visible.length > 1) return { choices: visible.map((p) => ({ id: p.id, label: p.name })), key: 'project', reason: `More than one project matches “${slots.project}”` };
    else return { error: `I can’t find a project called “${slots.project}” that you can see` };
    label.push(`in ${visible.find((p) => p.id === filters.projectId)?.name ?? 'the project'}`);
  }
  const ref = slots.meeting_reference;
  const period = periodOf(slots.period_text ?? ref, { now, timeZone });
  if (ref && /\bmeetings\b/.test(norm(ref))) {
    // "yesterday's meetings": every meeting in the period.
    filters.source = 'meeting';
    if (period) Object.assign(filters, { meetingsFrom: period.from.toISOString(), meetingsUntil: period.to.toISOString() });
    label.push(`from ${period ? `${period.label}’s` : 'recent'} meetings`);
  } else if (ref) {
    const m = chosen.meeting ? { meetingId: Number(chosen.meeting) } : await resolvePastMeeting(user, ref, { now, timeZone });
    if (m.choices) return { choices: m.choices, key: 'meeting', reason: m.reason };
    if (m.error) return { error: m.error };
    filters.meetingId = m.meetingId;
    label.push(`from “${m.label ?? 'the meeting'}”`);
  } else if (period) {
    Object.assign(filters, { since: period.from.toISOString(), until: period.to.toISOString() });
    label.push(`created ${period.label}`);
  }
  return { filters: { ...filters, view }, label: label.join(' ') };
}

async function selectItems(user, filters, { limit = 200 } = {}) {
  const { notDone, view, ...rest } = filters;
  const res = await center.list(user, { view, limit, offset: 0, ...rest });
  return res.items.filter((i) => !notDone || i.taskStatus !== 'done');
}

const line = (i) => ({ ref: { type: 'action_item', id: i.id }, title: i.title, status: i.lifecycle, owner: i.assignee?.fullName ?? i.assigneeTeam?.name ?? null, dueDate: i.dueDate, url: `/actions/${i.id}` });

/** query_work: a read-only, counted answer. */
export async function answerWorkQuery(user, slots, ctx) {
  const sel = await selectionFilters(user, slots, ctx);
  if (sel.error || sel.choices) return sel;
  const q = slots.work_query;
  if (q === 'overdue_commitments') sel.filters.view = 'overdue';
  if (q === 'project_blockers') sel.filters.view = 'blocked';
  const items = await selectItems(user, sel.filters);
  const what = sel.label ? ` ${sel.label}` : '';

  if (q === 'action_items') {
    return { text: items.length ? `${items.length} action item${items.length === 1 ? '' : 's'}${what}.` : `No action items${what} that you can see.`, items: items.map(line) };
  }
  if (q === 'overdue_commitments') {
    const today = localDate(ctx.now, ctx.timeZone);
    const rows = items.map((i) => ({ ...line(i), overdueDays: i.dueDate ? Math.round((new Date(today) - new Date(i.dueDate)) / 86_400_000) : null }));
    return { text: rows.length ? `${rows.length} overdue commitment${rows.length === 1 ? '' : 's'}${what}.` : `No overdue commitments${what}.`, items: rows };
  }
  if (q === 'project_blockers') {
    const ids = items.map((i) => i.id);
    const [ev] = ids.length ? await pool.query("SELECT action_item_id, excerpt, speaker FROM action_item_evidence WHERE action_item_id IN (?) AND relation IN ('origin','supporting') ORDER BY id", [ids]) : [[]];
    const first = new Map();
    for (const e of ev) if (!first.has(e.action_item_id)) first.set(e.action_item_id, e);
    const owners = [...new Set(items.map((i) => i.assignee?.fullName).filter(Boolean))];
    return {
      text: items.length ? `${items.length} blocked item${items.length === 1 ? '' : 's'}${what}${owners.length ? `; owners: ${owners.join(', ')}` : ''}.` : `Nothing is reported blocked${what}.`,
      items: items.map((i) => ({ ...line(i), blocker: first.get(i.id) ? `${first.get(i.id).speaker ? `${first.get(i.id).speaker}: ` : ''}“${first.get(i.id).excerpt}”` : null })),
    };
  }
  if (q === 'promised_vs_progress') {
    const approved = items.filter((i) => i.reviewStatus === 'approved');
    const links = await linkedWork(approved.map((i) => i.id));
    const rows = approved.map((i) => {
      const w = workStatus(i, links.get(i.id) ?? []);
      return { ...line(i), work: w.status, evidence: w.signals.map((s) => s.text) };
    });
    const count = (s) => rows.filter((r) => r.work === s).length;
    return {
      text: rows.length
        ? `${rows.length} commitment${rows.length === 1 ? '' : 's'}${what}: ${count('done')} done, ${count('implementation_complete')} with finished linked work (not yet confirmed), ${count('in_progress')} in progress, ${count('blocked')} blocked, ${count('not_started')} with no linked activity.`
        : `No approved commitments${what}.`,
      items: rows,
    };
  }
  if (q === 'pending_owners') {
    const pending = items.filter((i) => i.reviewStatus === 'approved' && i.taskStatus !== 'done' && i.assignee);
    const byOwner = Map.groupBy(pending, (i) => i.assignee.fullName);
    return { text: byOwner.size ? `${byOwner.size} people have pending action items${what}.` : `Nobody has pending action items${what}.`, items: [...byOwner].map(([name, its]) => ({ title: name, status: `${its.length} pending`, owner: name, url: null })) };
  }
  if (q === 'design_changes') {
    let since = sel.filters.meetingsFrom ?? sel.filters.since ?? null;
    if (sel.filters.meetingId) {
      const [[m]] = await pool.query('SELECT COALESCE(ended_at, started_at, scheduled_at) AS at FROM meetings WHERE id = ?', [sel.filters.meetingId]);
      since = m?.at ?? since;
    }
    since ??= new Date(ctx.now.getTime() - 7 * 86_400_000);
    const scope = await accessScope(user);
    const [rows] = await pool.query(
      `SELECT r.id, r.record_type, r.title, r.url, r.project_id, COALESCE(r.source_updated_at, r.source_created_at) AS at, p.title AS file
         FROM external_records r LEFT JOIN external_records p ON p.id = r.parent_record_id
        WHERE r.provider = 'figma' AND r.record_type IN ('version','comment','design_file') AND r.source_deleted_at IS NULL AND COALESCE(r.source_updated_at, r.source_created_at) >= ?
        ORDER BY at DESC LIMIT 100`,
      [new Date(since)],
    );
    const visible = rows.filter((r) => scope.admin || (r.project_id && scope.visibleSet.has(r.project_id)));
    const versions = visible.filter((r) => r.record_type === 'version').length;
    const comments = visible.filter((r) => r.record_type === 'comment').length;
    return {
      text: visible.length ? `Since then in Figma: ${versions} new version${versions === 1 ? '' : 's'} and ${comments} comment${comments === 1 ? '' : 's'}.` : 'No Figma changes since then in files you can see (or Figma is not connected).',
      items: visible.map((r) => ({ ref: { type: 'external_record', id: r.id }, title: `${r.record_type === 'version' ? 'Version' : r.record_type === 'comment' ? 'Comment' : 'File'}: ${r.title ?? ''}${r.file ? ` (${r.file})` : ''}`, status: r.record_type, url: `/records/${r.id}` })),
    };
  }
  return { text: 'I can’t answer that one yet.', items: [] };
}

const OPERATION_KIND = {
  create_jira_issues: 'jira.create_issue',
  email_owners: 'email.send',
  notify_owners: 'workagent.notify',
  post_to_teams: 'teams.message',
  send_meeting_summary: 'email.send',
  send_weekly_report: 'email.send',
};

/**
 * act_on_actions: selects the items, prepares an execution-engine plan and returns the card.
 * Returns { plan } | { error } | { choices, key, reason }.
 */
export async function planActions(user, slots, ctx, commandId) {
  const op = slots.operation;
  const kind = OPERATION_KIND[op];
  let options = {};
  let itemIds = [];
  if (op === 'send_weekly_report') {
    if (!slots.recipients) return { error: 'Who should receive the weekly report?' };
    const r = ctx.chosen.recipients ? { kind: 'person', id: Number(ctx.chosen.recipients) } : await resolveAttendee(user, slots.recipients);
    if (r.choices) return { choices: r.choices, key: 'recipients', reason: r.reason };
    if (r.error) return { error: r.error };
    let userIds = r.userIds ?? (r.kind === 'person' ? [r.id] : []);
    if (r.kind === 'group') userIds = (await pool.query('SELECT user_id FROM user_group_members WHERE group_id = ?', [r.id]))[0].map((x) => x.user_id);
    // The latest organisation-wide digest (numbers computed in code; narrative guarded), as a link.
    const [[d]] = await pool.query("SELECT id, scope_name, period_start, period_end, narrative, narrative_status FROM weekly_digests WHERE status = 'ready' ORDER BY period_end DESC, audience = 'executive' DESC, id DESC LIMIT 1");
    if (!d) return { error: 'There is no weekly digest yet. It is generated at the scheduled cut-off (Digests page).' };
    const narrative = typeof d.narrative === 'string' ? JSON.parse(d.narrative) : d.narrative;
    const summary = d.narrative_status === 'generated' ? (narrative?.summary ?? narrative?.text ?? null) : null;
    const week = String(d.period_end instanceof Date ? d.period_end.toISOString() : d.period_end).slice(0, 10);
    options = { template: 'custom', recipientUserIds: userIds, subject: `Weekly report (${d.scope_name}, week ending ${week})`, note: `${summary ? `${String(summary).slice(0, 2000)}\n\n` : ''}The full report, with the evidence behind every item, is in WorkAgent: /digests/${d.id}` };
  } else {
    const sel = await selectionFilters(user, slots, ctx);
    if (sel.error || sel.choices) return sel;
    if (op === 'create_jira_issues' && !slots.selection) sel.filters.reviewStatus = 'approved';
    if (['email_owners', 'notify_owners'].includes(op) && !slots.selection) Object.assign(sel.filters, { reviewStatus: 'approved', notDone: true });
    const items = (await selectItems(user, sel.filters)).filter((i) => i.reviewStatus === 'approved');
    if (!items.length) return { error: `No approved action items${sel.label ? ` ${sel.label}` : ''} that you can act on.` };
    itemIds = items.map((i) => i.id);
    if (op === 'email_owners') options = { template: slots.selection === 'overdue' ? 'reminder' : 'assignment' };
    if (op === 'send_meeting_summary') options = { template: 'meeting_summary', meetingId: sel.filters.meetingId ?? items.find((i) => i.meeting)?.meeting?.id ?? null };
    if (op === 'post_to_teams') options = { template: 'assignment' };
  }
  const prepared = await engine.prepare(user, { kind, actionItemIds: itemIds, options, origin: 'assistant', commandId });
  const p = prepared.preview;
  return {
    plan: {
      action: 'engine_plan',
      headline: `${p.summary}${p.affected.people ? ` — affects ${p.affected.people} ${p.affected.people === 1 ? 'person' : 'people'}` : ''}`,
      provider: p.provider,
      providerLabel: p.providerLabel,
      engine: { planId: prepared.planId, previewHash: prepared.previewHash, preview: p },
      blockers: [...p.blockers, ...(prepared.planId ? [] : [p.drafts.every((d) => d.skipped) ? 'Nothing to do: every item was skipped (see the reasons)' : 'Nothing can be executed as asked'])].filter(Boolean),
      warnings: p.warnings,
      requiresLargeConfirmation: p.requiresLargeConfirmation,
      recipientCount: p.affected.people,
    },
  };
}
