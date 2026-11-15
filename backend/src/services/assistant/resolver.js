// Entity resolution for assistant commands: names, groups, earlier meetings, tasks and Jira
// targets are matched against WorkAgent's own records, within what the requesting person may see.
// Nothing is guessed: one match resolves, several become a choice for the person, none becomes a
// clarification question.
import { pool } from '../../db/pool.js';
import * as aliasesRepo from '../../repositories/aliasesRepository.js';
import { exportTargets } from '../externalTasks.js';
import { listGroups } from '../groups/index.js';
import { buildDirectory, matchAssignee } from '../matching/assigneeMatcher.js';
import { isAdmin } from '../permissions.js';
import { accessScope, taskVisibilitySql } from '../records/access.js';
import { localDate } from '../../utils/dates.js';
import { wallClock } from '../scheduling/calendars.js';

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[’']s\b/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'my', 'our', 'of', 'for', 'to', 'task', 'ticket', 'issue', 'bug', 'item', 'with', 'and', 'on', 'in', 'this', 'that']);
const words = (s) => normalize(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

async function directory() {
  const [users] = await pool.query('SELECT id, full_name, email, is_active FROM users');
  const aliases = (await aliasesRepo.listAll()).map(aliasesRepo.toAlias);
  return { dir: buildDirectory(users.map((u) => ({ id: u.id, fullName: u.full_name, isActive: Boolean(u.is_active) })), aliases), users: new Map(users.map((u) => [u.id, u])) };
}

/** One person by name: { userId } | { choices } | { error }. */
export async function resolvePerson(name) {
  const { dir, users } = await directory();
  const m = matchAssignee(name, dir);
  if (m.userId) return { userId: m.userId, label: users.get(m.userId).full_name, match: m.match };
  if (m.flags.includes('ambiguous_assignee')) {
    return { choices: m.candidates.filter((c) => c.isActive).map((c) => ({ id: c.id, label: c.fullName, detail: users.get(c.id)?.email })), reason: `More than one person is called “${name}”` };
  }
  return { error: m.reason };
}

const groupKey = (s) => normalize(s).replace(/\b(the|team|teams|department|dept|group|squad|everyone in|everyone on|all of|all)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * One attendee phrase -> a person, a group, or a WorkAgent team (expanded to people).
 * Returns { kind: 'person'|'group'|'team', id, label, userIds? } | { choices } | { error }.
 */
export async function resolveAttendee(user, phrase) {
  const key = groupKey(phrase);
  let groups = key ? (await listGroups(user, { q: key })).filter((g) => groupKey(g.name) === key || groupKey(g.name).includes(key)) : [];
  // The words said narrow the type: "Payments department" is the department, "Payments project" the project team.
  const said = normalize(phrase);
  const hint = /\b(department|dept)\b/.test(said) ? ['department'] : /\bproject\b/.test(said) ? ['project'] : /\brole\b|\ball (managers|leads)\b/.test(said) ? ['role'] : null;
  if (hint && groups.some((g) => hint.includes(g.type))) groups = groups.filter((g) => hint.includes(g.type));
  const exactGroups = groups.filter((g) => groupKey(g.name) === key);
  const [teamRows] = key && !(hint && hint[0] !== 'project') ? await pool.query('SELECT id, name, lead_user_id FROM teams WHERE LOWER(name) LIKE ?', [`%${key}%`]) : [[]];
  const teams = teamRows.filter((t) => groupKey(t.name) === key);
  const person = /\b(team|department|dept|group|everyone|all)\b/.test(normalize(phrase)) ? { error: 'not a person' } : await resolvePerson(phrase);
  const options = [
    ...(person.userId ? [{ kind: 'person', id: person.userId, label: person.label }] : []),
    ...(person.choices ?? []).map((c) => ({ kind: 'person', id: c.id, label: c.label, detail: c.detail })),
    ...(exactGroups.length ? exactGroups : groups).map((g) => ({ kind: 'group', id: g.id, label: `${g.name} (${g.type}, ${g.memberCount ?? '?'} people)` })),
    ...teams.map((t) => ({ kind: 'team', id: t.id, label: `${t.name} (team)` })),
  ];
  if (options.length === 1) {
    const o = options[0];
    if (o.kind === 'team') return { ...o, userIds: await teamMembers(o.id) };
    return o;
  }
  if (options.length > 1) return { choices: options, reason: `“${phrase}” matches more than one person or group` };
  return { error: `I can’t find a person, group or team called “${phrase}”` };
}

export async function teamMembers(teamId) {
  const [rows] = await pool.query(
    `SELECT u.id FROM users u WHERE u.is_active = TRUE AND (u.id IN (SELECT user_id FROM team_members WHERE team_id = ?) OR u.id = (SELECT lead_user_id FROM teams WHERE id = ?))`,
    [teamId, teamId],
  );
  return rows.map((r) => r.id);
}

/** "this morning's standup" -> meetings the person organised or attended: { meetingId, userIds } | { choices } | { error }. */
export async function resolvePastMeeting(user, phrase, { now, timeZone }) {
  const p = normalize(phrase);
  const today = localDate(now, timeZone);
  let from = new Date(now.getTime() - 7 * 86_400_000);
  let to = now;
  if (/\b(this morning|today|earlier)\b/.test(p)) from = new Date(`${today}T00:00:00Z`);
  if (/\byesterday\b/.test(p)) {
    from = new Date(now.getTime() - 2 * 86_400_000);
    to = new Date(`${today}T00:00:00Z`);
  }
  const terms = words(p.replace(/\b(this morning|today|yesterday|earlier|last|everyone|who|was|were|attended|in|at|meeting)\b/g, ' '));
  const own = isAdmin(user) ? '' : 'AND (m.created_by = ? OR EXISTS (SELECT 1 FROM meeting_participants mp WHERE mp.meeting_id = m.id AND mp.user_id = ?))';
  const [rows] = await pool.query(
    `SELECT m.id, m.title, COALESCE(m.started_at, m.scheduled_at, m.created_at) AS at FROM meetings m
     WHERE COALESCE(m.started_at, m.scheduled_at, m.created_at) BETWEEN ? AND ? ${own} ORDER BY at DESC LIMIT 50`,
    [from, to, ...(isAdmin(user) ? [] : [user.id, user.id])],
  );
  const scored = rows.map((r) => ({ ...r, score: terms.filter((t) => normalize(r.title).includes(t)).length })).filter((r) => !terms.length || r.score > 0);
  if (/\bmorning\b/.test(p)) scored.splice(0, scored.length, ...scored.filter((r) => Number(wallClock(r.at, timeZone).slice(11, 13)) < 12));
  const best = Math.max(0, ...scored.map((r) => r.score));
  const top = scored.filter((r) => r.score === best);
  const membersOf = async (id) => (await pool.query('SELECT mp.user_id FROM meeting_participants mp JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ? AND u.is_active = TRUE', [id]))[0].map((r) => r.user_id);
  if (top.length === 1) return { meetingId: top[0].id, label: top[0].title, userIds: await membersOf(top[0].id) };
  if (top.length > 1) return { choices: top.slice(0, 5).map((r) => ({ kind: 'meeting', id: r.id, label: `${r.title} (${wallClock(r.at, timeZone).replace('T', ' ').slice(0, 16)})` })), reason: `More than one meeting matches “${phrase}”` };
  return { error: `I can’t find a recent meeting matching “${phrase}” that you attended` };
}

/**
 * An existing task: WorkAgent tasks the person may see, or Jira issues in visible projects.
 * Returns { ref: { type: 'action_item'|'external_record', id }, label } | { choices } | { error }.
 */
export async function resolveTask(user, phrase) {
  const scope = await accessScope(user);
  const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(phrase)?.[1] ?? null;
  const terms = words(phrase);
  const vis = taskVisibilitySql(scope);
  const [tasks] = await pool.query(
    `SELECT ai.id, ai.title, ai.task_status FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id
     WHERE ai.review_status = 'approved'${vis.sql ? ` AND ${vis.sql}` : ''} ORDER BY ai.updated_at DESC LIMIT 500`,
    vis.params,
  );
  const projectFilter = scope.admin ? '' : scope.visible.length ? 'AND r.project_id IN (?)' : 'AND FALSE';
  const [issues] = await pool.query(
    `SELECT r.id, r.title, r.external_key, r.status_category FROM external_records r
     WHERE r.provider = 'jira' AND r.record_type = 'issue' AND r.source_deleted_at IS NULL ${projectFilter} ORDER BY r.source_updated_at DESC LIMIT 1000`,
    scope.admin || !scope.visible.length ? [] : [scope.visible],
  );
  if (key) {
    const hit = issues.find((i) => i.external_key === key);
    return hit ? { ref: { type: 'external_record', id: hit.id }, label: `${hit.external_key} ${hit.title ?? ''}`.trim() } : { error: `I can’t find Jira issue ${key} in your projects` };
  }
  const score = (title) => {
    const t = new Set(words(title));
    const hits = terms.filter((w) => t.has(w)).length;
    return terms.length ? hits / terms.length : 0;
  };
  const candidates = [
    ...tasks.map((t) => ({ ref: { type: 'action_item', id: t.id }, label: t.title, detail: `WorkAgent task · ${t.task_status}`, score: score(t.title) })),
    ...issues.map((i) => ({ ref: { type: 'external_record', id: i.id }, label: `${i.external_key} ${i.title ?? ''}`.trim(), detail: `Jira · ${i.status_category}`, score: score(i.title ?? '') })),
  ].filter((c) => c.score >= 0.5).sort((a, b) => b.score - a.score);
  if (!candidates.length) return { error: `I can’t find a task matching “${phrase}” that you can see` };
  const top = candidates.filter((c) => c.score === candidates[0].score);
  if (top.length === 1) return { ref: top[0].ref, label: top[0].label };
  return { choices: top.slice(0, 6).map((c) => ({ kind: c.ref.type, id: c.ref.id, label: c.label, detail: c.detail })), reason: `More than one task matches “${phrase}”` };
}

/** Jira projects the assistant can create issues in (writable), optionally matched by a phrase. */
export async function resolveJiraTarget(phrase) {
  const targets = (await exportTargets()).filter((t) => t.canWrite);
  if (!targets.length) return { error: 'No Jira project accepts new issues from WorkAgent (connect Jira with JIRA_ISSUE_CREATION=true and enable a project)', targets };
  const all = targets.map((t) => ({ id: t.resourceId, label: `${t.key ?? t.name}${t.project ? ` · ${t.project.name}` : ''}`, key: t.key }));
  if (!phrase) return all.length === 1 ? { resourceId: all[0].id, label: all[0].label, only: true, targets: all } : { choices: all, reason: 'Which Jira project should the issue go to?', targets: all };
  const p = normalize(phrase).replace(/\b(project|the|board|team)\b/g, ' ').trim();
  const hits = targets.filter((t) => [t.key, t.name, t.project?.name].filter(Boolean).some((v) => normalize(v) === p || normalize(v).includes(p)));
  if (hits.length === 1) return { resourceId: hits[0].resourceId, label: `${hits[0].key ?? hits[0].name}${hits[0].project ? ` · ${hits[0].project.name}` : ''}`, targets: all };
  if (hits.length > 1) return { choices: hits.map((t) => ({ id: t.resourceId, label: t.key ?? t.name })), reason: `More than one Jira project matches “${phrase}”`, targets: all };
  return { choices: all, reason: `No Jira project matches “${phrase}”; choose one`, targets: all };
}
