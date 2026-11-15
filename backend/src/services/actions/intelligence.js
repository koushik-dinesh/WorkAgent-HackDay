// Deterministic parts of action intelligence, shared by every source (meeting transcripts, Teams
// messages, Jira/GitHub/Figma comments, Outlook mail):
//   - the closed set of action categories and a keyword classifier (the model may propose a
//     category; code validates it and falls back to these rules)
//   - owner kind: explicit person, inferred person, team, unassigned (never an invented person)
//   - team owners ("the design team needs to review this") resolved against WorkAgent teams and
//     departments; several matches stay unresolved
//   - deadline status: resolved / needs clarification / none (deadlines are never invented)
//   - a fingerprint of the underlying commitment, so the same promise found in a transcript, a
//     Teams thread and a Jira comment becomes one item with several pieces of evidence
import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { normalizeName } from '../matching/normalize.js';

export const CATEGORIES = [
  'task_assignment',
  'follow_up',
  'meeting_scheduling',
  'decision_implementation',
  'blocker_resolution',
  'design_correction',
  'code_implementation',
  'review_request',
  'deadline_change',
  'communication_required',
];

export const CATEGORY_LABELS = {
  task_assignment: 'Task assignment',
  follow_up: 'Follow-up',
  meeting_scheduling: 'Meeting scheduling',
  decision_implementation: 'Decision implementation',
  blocker_resolution: 'Blocker resolution',
  design_correction: 'Design correction',
  code_implementation: 'Code implementation',
  review_request: 'Review request',
  deadline_change: 'Deadline change',
  communication_required: 'Communication required',
};

// First match wins; order matters (a blocker that mentions code is still a blocker).
const RULES = [
  ['blocker_resolution', /\b(block(?:ed|er|s|ing)?|unblock|stuck|waiting on|depends on|delayed|cannot proceed|can't proceed|incident|outage)\b/],
  ['meeting_scheduling', /\b(schedule|set up|book|arrange|organi[sz]e)\b.{0,40}\b(meeting|call|sync|review|session|workshop|demo|follow-?up)\b/],
  ['deadline_change', /\b(move|push|postpone|extend|bring forward|reschedul\w*)\b.{0,40}\b(deadline|date|release|launch|due)\b/],
  ['review_request', /\b(review|approve|sign[- ]off|feedback on|take a look|second reviewer|qa)\b/],
  ['design_correction', /\b(design|mock(?:up)?s?|figma|ui|ux|contrast|layout|spacing|typography|icon|prototype|frame)\b/],
  ['code_implementation', /\b(fix|implement|build|code|refactor|migrat\w*|deploy|endpoint|api|bug|pr|pull request|merge|regression test|unit test)\b/],
  ['communication_required', /\b(tell|inform|notify|email|e-mail|announce|let .{1,30} know|communicat\w*|share .{0,30} with|update the (?:docs?|page|guidelines|notes|channel)|post .{0,20} (?:in|to))\b/],
  ['decision_implementation', /\b(decid\w*|decision|agreed|policy|standardi[sz]e|flag change)\b/],
  ['follow_up', /\b(follow[- ]?up|chase|check (?:in|back)|remind|circle back|ping)\b/],
];

/** Category from the model when valid, otherwise from the rules; null when nothing fits. */
export function classifyCategory(text, proposed = null) {
  if (proposed && CATEGORIES.includes(proposed)) return proposed;
  const t = ` ${String(text ?? '').toLowerCase()} `;
  for (const [category, re] of RULES) if (re.test(t)) return category;
  return 'task_assignment';
}

const STOP = new Set(['the', 'a', 'an', 'to', 'and', 'of', 'for', 'on', 'in', 'by', 'with', 'up', 'out', 'is', 'be', 'will', 'we', 'i', 'it', 'this', 'that', 'our', 'from', 'at', 'as', 'all', 'new']);
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

export function significantTokens(text) {
  return [...new Set(normalizeName(text ?? '').split(' ').filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
}

/** sha256 of owner + the commitment's significant words (order-independent). */
export function fingerprint({ title, assigneeUserId, assigneeTeamId, assigneeNameRaw }) {
  const owner = assigneeUserId ? `u${assigneeUserId}` : assigneeTeamId ? `t${assigneeTeamId}` : `n:${normalizeName(assigneeNameRaw ?? '')}`;
  const words = significantTokens(title).sort().slice(0, 12).join(' ');
  return createHash('sha256').update(`${owner}|${words}`).digest('hex');
}

export function similarity(a, b) {
  const x = new Set(significantTokens(a));
  const y = new Set(significantTokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

// ---- owners ---------------------------------------------------------------------------------------

const teamKey = (s) => normalizeName(s ?? '').replace(/\b(the|team|teams|department|dept|group|squad|folks|people|guys)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** WorkAgent teams and departments, for team owners. */
export async function loadTeams(conn = pool) {
  const [teams] = await conn.query('SELECT id, name, lead_user_id FROM teams');
  const [departments] = await conn.query('SELECT id, name FROM departments').catch(() => [[]]);
  return { teams, departments };
}

/**
 * Resolves a group phrase ("the design team", "Payments") to one team or department.
 * @returns {{ teamId, departmentId, name } | { ambiguous: [...] } | null}
 */
export function resolveTeam(phrase, { teams, departments }) {
  const key = teamKey(phrase);
  if (!key) return null;
  const matches = [
    ...teams.filter((t) => teamKey(t.name) === key || teamKey(t.name).split(' ').includes(key)).map((t) => ({ teamId: t.id, departmentId: null, name: t.name })),
    ...departments.filter((d) => teamKey(d.name) === key).map((d) => ({ teamId: null, departmentId: d.id, name: d.name })),
  ];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exactTeam = matches.filter((m) => m.teamId && teamKey(teams.find((t) => t.id === m.teamId).name) === key);
    if (exactTeam.length === 1) return exactTeam[0];
    return { ambiguous: matches };
  }
  return null;
}

const TEAM_WORDS = /\b(team|department|dept|squad|group|everyone|all of us|folks)\b/i;

/**
 * Owner kind for a validated item (validator already matched the person or refused to):
 *   explicit   a person matched by full name or alias (or a manual choice)
 *   inferred   a person matched by first name only, or the model was unsure
 *   team       no person, but a team or department was named
 *   unassigned nobody
 */
export function ownerOf(item, teamsIndex, { modelKind = null, teamPhrase = null } = {}) {
  if (item.assigneeUserId) {
    const inferred = item.assigneeMatch === 'fuzzy' || modelKind === 'inferred' || (item.flags ?? []).includes('uncertain_assignee');
    return { assigneeKind: inferred ? 'inferred' : 'explicit', assigneeTeamId: null, teamCandidates: [] };
  }
  const phrase = teamPhrase ?? (item.assigneeNameRaw && TEAM_WORDS.test(item.assigneeNameRaw) ? item.assigneeNameRaw : null) ?? item.assigneeNameRaw;
  if (phrase && teamsIndex) {
    const t = resolveTeam(phrase, teamsIndex);
    if (t?.teamId || t?.departmentId) return { assigneeKind: 'team', assigneeTeamId: t.teamId, departmentId: t.departmentId, teamName: t.name, teamCandidates: [] };
    if (t?.ambiguous) return { assigneeKind: 'unassigned', assigneeTeamId: null, teamCandidates: t.ambiguous };
  }
  return { assigneeKind: 'unassigned', assigneeTeamId: null, teamCandidates: [] };
}

export function deadlineStatusOf(item) {
  if (item.dueDate) return 'resolved';
  if (item.dueDateRaw) return 'needs_clarification';
  return 'none';
}

/**
 * Adds category, owner kind, team, deadline status, timezone and fingerprint to validated items.
 * `extras[i]` may carry the model's category / owner kind / team phrase for item i.
 */
export function enrichItems(items, { teamsIndex = null, timeZone = null, extras = [] } = {}) {
  return items.map((item, i) => {
    const x = extras[i] ?? {};
    const owner = ownerOf(item, teamsIndex, { modelKind: x.ownerKind, teamPhrase: x.teamPhrase });
    const flags = [...(item.flags ?? [])];
    if (owner.assigneeKind === 'team' && flags.includes('unknown_assignee')) flags.splice(flags.indexOf('unknown_assignee'), 1, 'team_owner');
    if (owner.teamCandidates.length) flags.push('ambiguous_team');
    const enriched = {
      ...item,
      flags: [...new Set(flags)],
      category: classifyCategory(`${item.title} ${item.description ?? ''}`, x.category),
      assigneeKind: owner.assigneeKind,
      assigneeTeamId: owner.assigneeTeamId ?? null,
      departmentId: owner.departmentId ?? null,
      deadlineStatus: deadlineStatusOf(item),
      dueTimezone: item.dueDate || item.dueDateRaw ? timeZone : null,
      reviewDetails: { ...(item.reviewDetails ?? {}), owner: { kind: owner.assigneeKind, team: owner.teamName ?? null, teamCandidates: owner.teamCandidates } },
    };
    enriched.fingerprint = fingerprint(enriched);
    return enriched;
  });
}
