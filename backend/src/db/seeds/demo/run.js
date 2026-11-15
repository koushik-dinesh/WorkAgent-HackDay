// Builds the Arclight Labs development dataset (docs/SEED_DATA_ARCHITECTURE.md §5). Loaded by
// ../demoSeed.js after the environment is prepared. Writes in foreign-key order, through the
// application's own mappers, ingest, audit-to-activity mapping, notification triggers and
// execution engine. Makes no AI calls and sends nothing outside WorkAgent.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../../config/index.js';
import { pool } from '../../pool.js';
import { withTransaction } from '../../transaction.js';
import * as activitiesRepo from '../../../repositories/activitiesRepository.js';
import { recordInternalActivities } from '../../../services/activities/internal.js';
import { hashPassword } from '../../../services/authService.js';
import { scheduleForAudit } from '../../../services/correlation/schedule.js';
import * as engine from '../../../services/execution/index.js';
import { ensureDerivedGroups } from '../../../services/groups/index.js';
import { ingest } from '../../../services/integrations/ingest.js';
import { createLink } from '../../../services/integrations/links.js';
import * as figmaMap from '../../../services/integrations/providers/figma/index.js';
import * as ghMap from '../../../services/integrations/providers/github/mappers.js';
import * as jiraMap from '../../../services/integrations/providers/jira/mappers.js';
import { emailEnvelopes, eventEnvelopes } from '../../../services/integrations/providers/microsoft/outlook.js';
import { messageEnvelopes } from '../../../services/integrations/providers/microsoft/teams.js';
import { normalizeName } from '../../../services/matching/normalize.js';
import { notify } from '../../../services/notifications/inbox.js';
import { notifyForAudit, scan as notificationScan } from '../../../services/notifications/triggers.js';
import { renderFullText } from '../../../services/transcripts/parser.js';
import * as comms from './comms.js';
import { ANCHOR, DOMAIN, OFFICE_TZ, PASSWORD, SEED_SOURCE, at, day, hexOf, isWeekday, rng } from './config.js';
import { GH_ISSUES, GH_ORG, GH_USERS, MAIN_COMMITS, PULLS, REPOS } from './github.js';
import { JIRA_ISSUES, JIRA_PROJECTS } from './jira.js';
import { ATLAS_MEETINGS } from './meetings/atlas.js';
import { CANVAS_MEETINGS, NOVA_MEETINGS } from './meetings/canvas.js';
import { ORION_MEETINGS, SENTINEL_MEETINGS } from './meetings/orion.js';
import { HORIZON_MEETINGS, LEADERSHIP_MEETINGS, PULSE_MEETINGS, UPCOMING_MEETINGS } from './meetings/pulse.js';
import { COMPANY, DEPARTMENTS, PEOPLE, TEAMS } from './org.js';
import { PROJECTS } from './projects.js';

const { FIGMA_FILES, FIGMA_FOLDERS, TEAMS_CHANNELS, TEAMS_POSTS, EMAILS, EXTERNAL_PEOPLE, SOURCE_ITEMS } = comms;
const MEETINGS = [...ATLAS_MEETINGS, ...ORION_MEETINGS, ...SENTINEL_MEETINGS, ...CANVAS_MEETINGS, ...NOVA_MEETINGS, ...PULSE_MEETINGS, ...HORIZON_MEETINGS, ...LEADERSHIP_MEETINGS];
const P = Object.fromEntries(PEOPLE.map((p) => [p.key, p]));
const PROJ = Object.fromEntries(PROJECTS.map((p) => [p.key, p]));
const ISSUE = Object.fromEntries(JIRA_ISSUES.map((i, n) => [i.key, { ...i, id: String(20001 + n) }]));
const NOW = new Date();
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const later = (...ds) => new Date(Math.max(...ds.filter(Boolean).map((d) => new Date(d).getTime())));
const notAfterNow = (d) => new Date(Math.min(new Date(d).getTime(), NOW.getTime() - 5 * MIN));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const SRC = (provider) => `seed.arclight-labs/${provider}`;

// ---- dataset validation ---------------------------------------------------------------------------

function validate() {
  const errors = [];
  const err = (m) => errors.push(m);
  const person = (k, ctx, d = null) => {
    if (!P[k]) return err(`${ctx}: unknown person ${k}`);
    if (d !== null && d < P[k].joined) err(`${ctx}: ${k} acts on day ${d} before joining (${P[k].joined})`);
  };
  const emails = new Set();
  for (const p of PEOPLE) {
    if (emails.has(p.email)) err(`duplicate e-mail ${p.email}`);
    emails.add(p.email);
    if (p.manager) person(p.manager, `manager of ${p.key}`);
  }
  const itemKeys = new Set();
  const allItems = [...MEETINGS.flatMap((m) => (m.items ?? []).map((i) => ({ ...i, meeting: m }))), ...SOURCE_ITEMS];
  for (const i of allItems) {
    if (itemKeys.has(i.key)) err(`duplicate item key ${i.key}`);
    itemKeys.add(i.key);
  }
  for (const m of [...MEETINGS, ...UPCOMING_MEETINGS]) {
    const ctx = `meeting ${m.key}`;
    if (!isWeekday(m.day)) err(`${ctx}: day ${m.day} (${day(m.day)}) is a weekend`);
    if (m.project && !PROJ[m.project]) err(`${ctx}: unknown project ${m.project}`);
    if (m.project && m.day < PROJ[m.project].start - 3) err(`${ctx}: before its project starts`);
    person(m.organizer, ctx, m.day);
    for (const a of m.attendees) person(a, ctx, m.day);
    if (!m.attendees.includes(m.organizer)) err(`${ctx}: organizer not an attendee`);
    (m.transcript ?? []).forEach(([s], n) => {
      if (!m.attendees.includes(s)) err(`${ctx}: line ${n} speaker ${s} is not an attendee`);
    });
    for (const d of m.decisions ?? []) if (!m.transcript[d.line]) err(`${ctx}: decision line ${d.line} out of range`);
    for (const i of m.items ?? []) {
      const ictx = `${ctx} item ${i.key}`;
      if (!m.transcript[i.line]) err(`${ictx}: evidence line ${i.line} out of range`);
      person(i.owner, ictx, m.day);
      if (i.jira && !ISSUE[i.jira]) err(`${ictx}: unknown Jira issue ${i.jira}`);
      if (i.blockedBy && !itemKeys.has(i.blockedBy)) err(`${ictx}: unknown blocker ${i.blockedBy}`);
      if (i.started !== undefined && i.started < m.day) err(`${ictx}: started before the meeting`);
      if (i.done !== undefined && (i.done < (i.started ?? m.day) || i.done > 0)) err(`${ictx}: bad done day`);
      if (i.status === 'done' && i.done === undefined) err(`${ictx}: done without a done day`);
      if (['in_progress', 'blocked'].includes(i.status) && i.started === undefined) err(`${ictx}: ${i.status} without a start day`);
    }
  }
  for (const i of SOURCE_ITEMS) {
    person(i.owner, `source item ${i.key}`);
    if (i.jira && !ISSUE[i.jira]) err(`source item ${i.key}: unknown Jira issue ${i.jira}`);
  }
  for (const i of JIRA_ISSUES) {
    const ctx = `Jira ${i.key}`;
    person(i.assignee, ctx, i.created);
    person(i.reporter, ctx, i.created);
    if (i.parent && !ISSUE[i.parent]) err(`${ctx}: unknown parent ${i.parent}`);
    for (const l of i.links ?? []) if (!ISSUE[l.to]) err(`${ctx}: unknown link target ${l.to}`);
    for (const c of i.comments ?? []) {
      person(c.by, `${ctx} comment`, c.day);
      if (c.day < i.created) err(`${ctx}: comment before the issue was created`);
    }
    if (i.resolved !== undefined && i.resolved < i.created) err(`${ctx}: resolved before created`);
    if ((i.status === 'Done') !== (i.resolved !== undefined)) err(`${ctx}: status/resolution mismatch`);
  }
  for (const pr of PULLS) {
    const ctx = `PR ${pr.repo}#${pr.number}`;
    person(pr.author, ctx, Math.min(...pr.commits.map((c) => c.day)));
    if (pr.merged !== undefined && pr.merged < pr.created) err(`${ctx}: merged before opened`);
    for (const j of pr.jira) if (!ISSUE[j]) err(`${ctx}: unknown Jira ${j}`);
    for (const c of pr.commits) person(c.by, `${ctx} commit`, c.day);
    for (const r of pr.reviews) {
      person(r.by, `${ctx} review`, r.day);
      if (r.day < pr.created) err(`${ctx}: review before the PR was opened`);
    }
  }
  for (const f of FIGMA_FILES) for (const c of f.comments) {
    person(c.by, `Figma ${f.name}`, c.day);
    if (c.day < f.created) err(`Figma ${f.name}: comment before the file existed`);
  }
  for (const post of TEAMS_POSTS) {
    person(post.by, `Teams ${post.id}`, post.day);
    for (const r of post.replies) if (r.day < post.day) err(`Teams ${r.id}: reply before its post`);
  }
  if (errors.length) throw new Error(`Dataset validation failed:\n- ${errors.join('\n- ')}`);
  return { items: allItems.length };
}

// ---- small helpers --------------------------------------------------------------------------------

const ids = { user: {}, dept: {}, team: {}, project: {}, meeting: {}, item: {}, record: {}, connection: {}, resource: {} };
const primaryTeam = (k) => TEAMS.find((t) => t.lead === k) ?? TEAMS.find((t) => t.members.includes(k) && t.key !== 'strategy') ?? null;

async function register(conn, entityType, entityId, naturalKey, metadata = null) {
  await conn.execute('INSERT INTO mock_records (source, entity_type, entity_id, natural_key, metadata) VALUES (?, ?, ?, ?, ?)', [SEED_SOURCE, entityType, entityId, naturalKey, json(metadata)]);
}

// A dated audit entry with the same side effects the app's recordAudit has (WorkAgent activities,
// relationship re-evaluation, notifications), all placed at `when`.
async function historical(conn, { when, actor = null, action, entityType, entityId, before = null, after = null }) {
  const [[{ maxNotif }]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS maxNotif FROM notifications');
  const actorUserId = actor ? ids.user[actor] : null;
  const [r] = await conn.execute(
    'INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [actorUserId, action, entityType, entityId, json(before), json(after), when],
  );
  await recordInternalActivities(conn, { auditId: r.insertId, action, entityId, actorUserId, before, after }, when);
  await scheduleForAudit(conn, { action, entityId });
  await notifyForAudit(conn, { action, entityId, actorUserId, before, after });
  await datedNotifications(conn, maxNotif, when);
}

/** Moves notifications created after `afterId` to `when`; older ones count as read. */
async function datedNotifications(conn, afterId, when) {
  const old = NOW.getTime() - new Date(when).getTime() > 4 * 86_400_000;
  await conn.execute('UPDATE notifications SET created_at = ?, read_at = ? WHERE id > ?', [when, old ? new Date(new Date(when).getTime() + 3 * HOUR) : null, afterId]);
}

// ---- 1. organisation ------------------------------------------------------------------------------

async function seedOrganisation(conn) {
  const passwordHash = PASSWORD ? await hashPassword(PASSWORD) : null;
  for (const d of DEPARTMENTS) {
    ids.dept[d.key] = (await conn.execute("INSERT INTO departments (name, source, created_at) VALUES (?, 'workagent', ?)", [d.name, at(-1500)]))[0].insertId;
    await register(conn, 'department', ids.dept[d.key], `department:${d.key}`);
  }
  for (const p of PEOPLE) {
    const joined = at(p.joined, '09:30');
    ids.user[p.key] = (
      await conn.execute(
        "INSERT INTO users (email, full_name, password_hash, role, department_id, job_title, directory_source, hr_access, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, TRUE, ?, ?)",
        [p.email, p.name, passwordHash, p.role, ids.dept[p.dept], p.title, p.key === 'siddharth', joined, joined],
      )
    )[0].insertId;
    await register(conn, 'user', ids.user[p.key], `user:${p.key}`, { managerKey: p.manager, skills: p.skills, joined: day(p.joined), team: primaryTeam(p.key)?.name ?? null });
  }
  for (const p of PEOPLE) {
    for (const a of p.aliases) await conn.execute('INSERT INTO user_aliases (user_id, alias, normalized_alias, created_at) VALUES (?, ?, ?, ?)', [ids.user[p.key], a, normalizeName(a), at(p.joined, '10:00')]);
    await conn.execute('INSERT INTO user_preferences (user_id, settings) VALUES (?, ?)', [ids.user[p.key], json({ timeZone: OFFICE_TZ })]);
  }
  await conn.execute('UPDATE departments SET created_by = ?', [ids.user.koushik]);
  for (const t of TEAMS) {
    ids.team[t.key] = (await conn.execute('INSERT INTO teams (name, description, lead_user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [t.name, t.description, ids.user[t.lead], ids.user.koushik, at(-420)]))[0].insertId;
    for (const m of t.members) await conn.execute('INSERT INTO team_members (team_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)', [ids.team[t.key], ids.user[m], ids.user[t.lead], later(at(-420), at(P[m].joined, '11:00'))]);
    await register(conn, 'team', ids.team[t.key], `team:${t.key}`, { department: t.dept });
  }
  for (const p of PROJECTS) {
    const created = at(p.start, '09:15');
    ids.project[p.key] = (
      await conn.execute('INSERT INTO projects (name, description, status, owner_user_id, start_date, target_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        p.name, p.description, p.status, ids.user[p.owner], day(p.start), day(p.target), ids.user.koushik, created, created,
      ])
    )[0].insertId;
    for (const m of new Set([p.owner, ...p.members])) {
      await conn.execute('INSERT INTO project_members (project_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)', [ids.project[p.key], ids.user[m], ids.user[p.owner], later(created, at(P[m].joined, '11:00'))]);
    }
    await register(conn, 'project', ids.project[p.key], `project:${p.key}`, { priority: p.priority, jiraKey: p.jiraKey, repo: p.repo, teams: p.teams });
  }
  await ensureDerivedGroups(conn);
  const custom = [
    { name: 'Architecture Review Board', description: 'Reviews service boundaries, delivery guarantees and data retention before implementation starts.', owner: 'koushik', members: ['koushik', 'keerthan', 'aaryan', 'meera', 'thiru'] },
    { name: 'Release Captains', description: 'Owns go/no-go preparation, release gates and customer communication for every release.', owner: 'priya', members: ['priya', 'anjana', 'keerthan', 'kavya', 'thiru'] },
    { name: 'Enterprise Pilot Squad', description: 'Everyone with a direct line to the Northbridge, Crestline and Meridian pilots.', owner: 'kavya', members: ['kavya', 'koushik', 'siddharth', 'rohan', 'priya'] },
  ];
  for (const g of custom) {
    const gid = (await conn.execute("INSERT INTO user_groups (name, description, group_type, source, owner_user_id, created_by, created_at) VALUES (?, ?, 'custom', 'workagent', ?, ?, ?)", [g.name, g.description, ids.user[g.owner], ids.user[g.owner], at(-70)]))[0].insertId;
    for (const m of g.members) await conn.execute("INSERT INTO user_group_members (group_id, user_id, source, added_by, added_at) VALUES (?, ?, 'manual', ?, ?)", [gid, ids.user[m], ids.user[g.owner], at(-70)]);
    await register(conn, 'group', gid, `group:${slug(g.name)}`);
  }
}

// ---- 2. integrations: seeded history through the real mappers and ingest --------------------------

async function connection(conn, provider, label, account) {
  const id = (
    await conn.execute(
      `INSERT INTO integration_connections (provider, source_instance, external_account_id, account_login, account_type, display_name, status, is_enabled, settings, health,
         connected_by, connected_at, disconnected_by, disconnected_at, created_at)
       VALUES (?, ?, ?, ?, 'organization', ?, 'disconnected', FALSE, ?, 'unknown', ?, ?, ?, ?, ?)`,
      [provider, SRC(provider), `seed-${provider}`, account, `${label} · ${COMPANY} (seeded history)`, json({ mode: 'seed', seed: true, verified: false, organisation: COMPANY, note: 'Development dataset. Not connected to the provider; nothing is synced or written.' }),
        ids.user.koushik, at(-95, '09:00'), ids.user.koushik, NOW, at(-95, '09:00')],
    )
  )[0].insertId;
  ids.connection[provider] = id;
  await register(conn, 'connection', id, `connection:${provider}`);
  return { id };
}

async function resource(conn, provider, { type, externalId, name, project = null, metadata = null }) {
  const id = (
    await conn.execute('INSERT INTO integration_resources (connection_id, resource_type, external_id, name, url, access_status, is_enabled, project_id, metadata, created_at) VALUES (?, ?, ?, ?, NULL, \'accessible\', FALSE, ?, ?, ?)', [
      ids.connection[provider], type, externalId, name, project ? ids.project[project] : null, json(metadata), at(-95, '09:05'),
    ])
  )[0].insertId;
  ids.resource[`${provider}:${externalId}`] = id;
  return { id, projectId: project ? ids.project[project] : null };
}

async function recordId(conn, provider, recordType, externalId) {
  const [[r]] = await conn.query('SELECT id FROM external_records WHERE provider = ? AND source_instance = ? AND record_type = ? AND external_id = ?', [provider, SRC(provider), recordType, String(externalId)]);
  return r?.id ?? null;
}

const run = (conn, provider, res, envelopes) => ingest(conn, { connector: { id: provider, sourceInstance: SRC(provider) }, connection: { id: ids.connection[provider] }, resource: res, envelopes, origin: 'sync' });

// Jira
const jiraUser = (k) => ({ accountId: `seed-acc-${k}`, displayName: P[k].name, emailAddress: P[k].email, accountType: 'atlassian' });
const STATUS_KEY = { 'To Do': 'new', 'In Progress': 'indeterminate', 'In Review': 'indeterminate', Blocked: 'indeterminate', Done: 'done' };
const LINK_NAME = { blocks: 'Blocks', relates: 'Relates', duplicate: 'Duplicate' };

function issueTimes(i) {
  const r = rng(Number(ISSUE[i.key].id));
  const created = at(i.created, '10:00', Math.floor(r() * 240));
  const comments = (i.comments ?? []).map((c, n) => ({ ...c, at: later(at(c.day, '11:00', Math.floor(r() * 420)), new Date(created.getTime() + (n + 1) * 10 * MIN)) }));
  const resolved = i.resolved !== undefined ? later(at(i.resolved, '17:00', Math.floor(r() * 90)), created) : null;
  const updated = later(created, resolved, ...comments.map((c) => c.at));
  return { created, comments, resolved, updated };
}

async function seedJira(conn) {
  await connection(conn, 'jira', 'Jira', 'arclight-labs');
  for (const jp of JIRA_PROJECTS) {
    const res = await resource(conn, 'jira', { type: 'project', externalId: jp.id, name: jp.key, project: jp.project, metadata: { key: jp.key, name: jp.name, projectType: 'software' } });
    const envs = [];
    for (const i of JIRA_ISSUES.filter((x) => x.key.startsWith(`${jp.key}-`))) {
      const t = issueTimes(i);
      const id = ISSUE[i.key].id;
      const payload = {
        id,
        key: i.key,
        fields: {
          summary: i.summary,
          description: i.description,
          status: { name: i.status, statusCategory: { key: STATUS_KEY[i.status] } },
          priority: { name: i.priority },
          issuetype: { name: i.type, subtask: i.type === 'Sub-task' },
          project: { key: jp.key },
          assignee: jiraUser(i.assignee),
          reporter: jiraUser(i.reporter),
          creator: jiraUser(i.reporter),
          created: iso(t.created),
          updated: iso(t.updated),
          duedate: i.due !== undefined ? day(i.due) : null,
          labels: i.labels ?? [],
          resolution: i.status === 'Done' ? { name: 'Done' } : null,
          resolutiondate: iso(t.resolved),
          parent: i.parent ? { id: ISSUE[i.parent].id, key: i.parent } : undefined,
          issuelinks: (i.links ?? []).map((l) => ({ type: { name: LINK_NAME[l.type] }, outwardIssue: { id: ISSUE[l.to].id, key: l.to } })),
          comment: { comments: t.comments.map((c, n) => ({ id: `${id}${String(n + 1).padStart(2, '0')}`, author: jiraUser(c.by), body: c.text, created: iso(c.at), updated: iso(c.at) })) },
        },
      };
      envs.push(...jiraMap.issueEnvelopes(SRC('jira'), null, payload));
      // Status history the sync would have seen as transitions.
      const ref = { recordType: 'issue', externalId: id };
      const act = (k, type, when, summary, actor = i.assignee) => envs.push({ type: 'activity', dedupeKey: `jira:${SRC('jira')}:issue:${id}:${k}`, activityType: type, recordRef: ref, actorRef: { externalUserId: `seed-acc-${actor}` }, occurredAt: iso(when), summary });
      if (i.status !== 'To Do') act('started', 'started', notAfterNow(later(new Date(t.created.getTime() + 20 * HOUR), t.created)), `${P[i.assignee].name} started ${i.key} ${i.summary}`);
      if (i.status === 'In Review') act('in_review', 'status_changed', new Date(t.updated.getTime() - HOUR), `${i.key} moved to In Review`);
      if (i.status === 'Blocked') act('blocked', 'blocked', new Date(t.updated.getTime() - HOUR), `${i.key} was marked as blocked`);
      if (t.resolved) act('done', 'completed', t.resolved, `${P[i.assignee].name} completed ${i.key} ${i.summary}`);
    }
    // Parents before children: epics and stories first, sub-tasks last (ingest resolves parents in order).
    await run(conn, 'jira', res, envs);
  }
  // Second pass so links between projects resolve (both ends now exist).
  const linkEnvs = JIRA_ISSUES.flatMap((i) => [
    ...(i.links ?? []).map((l) => ({ type: 'link', fromRef: { recordType: 'issue', externalId: ISSUE[i.key].id }, toRef: { recordType: 'issue', externalId: ISSUE[l.to].id }, linkType: l.type === 'blocks' ? 'blocks' : l.type === 'duplicate' ? 'duplicates' : 'related' })),
    ...(i.parent ? [{ type: 'link', fromRef: { recordType: 'issue', externalId: ISSUE[i.parent].id }, toRef: { recordType: 'issue', externalId: ISSUE[i.key].id }, linkType: 'includes' }] : []),
  ]);
  await run(conn, 'jira', null, linkEnvs);
  for (const i of JIRA_ISSUES) ids.record[`jira:${i.key}`] = await recordId(conn, 'jira', 'issue', ISSUE[i.key].id);
}

// GitHub
const ghUser = (k) => ({ ...GH_USERS[k], type: 'User' });
const ORG_USER = { id: 90001, login: GH_ORG, type: 'Organization' };
const shaOf = (...parts) => hexOf(parts.join('|'), 40);

async function seedGithub(conn) {
  await connection(conn, 'github', 'GitHub', GH_ORG);
  for (const repo of REPOS) {
    const full = `${GH_ORG}/${repo.key}`;
    const repoPayload = { id: repo.id, name: repo.key, full_name: full, owner: ORG_USER, html_url: null, description: repo.description, default_branch: 'main', private: true, visibility: 'private', archived: false, created_at: iso(at(repo.created)), updated_at: iso(at(-1, '20:00')) };
    const res = await resource(conn, 'github', { type: 'repository', externalId: String(repo.id), name: full, project: repo.project, metadata: { name: repo.key, fullName: full, description: repo.description, owner: GH_ORG, ownerType: 'Organization', defaultBranch: 'main', visibility: 'private', private: true, archived: false } });
    const envs = [...ghMap.repositoryEnvelopes(SRC('github'), repoPayload)];
    const r = rng(repo.id);
    const commitEnv = (c, branch, extra = '') => {
      const when = at(c.day, '11:00', Math.floor(r() * 480));
      const message = `${c.msg}${extra}`;
      const sha = shaOf(repo.key, c.msg, c.day);
      envs.push(...ghMap.commitEnvelopes(SRC('github'), repoPayload, { sha, message, authorUser: ghUser(c.by), authorName: P[c.by].name, committerName: P[c.by].name, authoredAt: iso(when), committedAt: iso(when), branch, url: null, verified: true, pusher: null }));
      return { sha, when };
    };
    for (const c of MAIN_COMMITS.filter((x) => x.repo === repo.key)) commitEnv(c, 'main');
    for (const pr of PULLS.filter((x) => x.repo === repo.key)) {
      const commits = pr.commits.map((c) => ({ ...commitEnv(c, pr.branch, pr.jira.length ? `\n\nRefs ${pr.jira.join(', ')}` : '') }));
      const firstCommit = new Date(Math.min(...commits.map((c) => c.when.getTime())));
      const lastCommit = new Date(Math.max(...commits.map((c) => c.when.getTime())));
      const created = later(at(pr.created, '12:00', Math.floor(r() * 300)), new Date(firstCommit.getTime() + 20 * MIN));
      const merged = pr.merged !== undefined ? later(at(pr.merged, '15:00', Math.floor(r() * 180)), created, new Date(lastCommit.getTime() + 30 * MIN)) : null;
      const mergeSha = merged ? shaOf(repo.key, 'merge', pr.number) : null;
      if (merged) envs.push(...ghMap.commitEnvelopes(SRC('github'), repoPayload, { sha: mergeSha, message: `Merge pull request #${pr.number} from ${GH_ORG}/${pr.branch}\n\n${pr.title}`, authorUser: ghUser(pr.mergedBy), authorName: P[pr.mergedBy].name, committerName: 'GitHub', authoredAt: iso(merged), committedAt: iso(merged), branch: 'main', url: null, verified: true }));
      const reviews = pr.reviews.map((rv, n) => ({ ...rv, id: pr.number * 1000 + n + 1, at: later(at(rv.day, '14:00', Math.floor(r() * 200)), created) }));
      const approvedBy = new Set(reviews.filter((x) => x.state === 'approved').map((x) => x.by));
      const updated = later(created, merged, ...reviews.map((x) => x.at), ...commits.map((c) => c.when));
      const payload = {
        id: repo.id * 1000 + pr.number, number: pr.number, title: pr.title, body: pr.body, state: merged ? 'closed' : 'open', user: ghUser(pr.author), assignees: [ghUser(pr.author)],
        requested_reviewers: merged ? [] : pr.reviewers.filter((k) => !approvedBy.has(k)).map(ghUser), requested_teams: [], labels: pr.jira.map((j) => ({ name: j.split('-')[0].toLowerCase() })),
        created_at: iso(created), updated_at: iso(updated), merged_at: iso(merged), closed_at: iso(merged), merged_by: merged ? ghUser(pr.mergedBy) : null, merge_commit_sha: mergeSha,
        head: { ref: pr.branch, sha: commits.at(-1).sha }, base: { ref: 'main' }, html_url: null, draft: false, milestone: null,
      };
      envs.push(...ghMap.pullEnvelopes(SRC('github'), repoPayload, payload));
      const prRef = { recordType: 'pull_request', externalId: `${repo.id}#${pr.number}` };
      for (const c of commits) envs.push({ type: 'link', fromRef: prRef, toRef: { recordType: 'commit', externalId: `${repo.id}:${c.sha}` }, linkType: 'includes' });
      for (const k of pr.reviewers) envs.push({ type: 'activity', dedupeKey: `${SRC('github')}:pull_request:${prRef.externalId}:review_requested:${GH_USERS[k].id}`, activityType: 'review_requested', recordRef: prRef, actorRef: { externalUserId: String(GH_USERS[pr.author].id) }, occurredAt: iso(new Date(created.getTime() + 5 * MIN)), summary: `${GH_USERS[pr.author].login} requested a review from ${GH_USERS[k].login} on ${full}#${pr.number}` });
      for (const rv of reviews) envs.push(...ghMap.reviewEnvelopes(SRC('github'), repoPayload, pr.number, { id: rv.id, user: ghUser(rv.by), state: rv.state.toUpperCase(), body: rv.body, submitted_at: iso(rv.at), html_url: null, commit_id: commits.at(-1).sha }));
      (pr.reviewComments ?? []).forEach((c, n) => envs.push(...ghMap.reviewCommentEnvelopes(SRC('github'), repoPayload, { id: pr.number * 1000 + 500 + n, user: ghUser(c.by), body: c.body, path: c.path, line: c.line, created_at: iso(at(c.day, '13:30')), updated_at: iso(at(c.day, '13:30')), pull_request_review_id: reviews[0]?.id ?? null }, pr.number)));
    }
    for (const is of GH_ISSUES.filter((x) => x.repo === repo.key)) {
      const created = at(is.created, '10:40');
      const closed = is.closed !== undefined ? at(is.closed, '16:20') : null;
      const issue = { id: repo.id * 1000 + 800 + is.number, number: is.number, title: is.title, body: is.body, state: closed ? 'closed' : 'open', state_reason: closed ? 'completed' : null, user: ghUser(is.author), assignees: [], labels: is.labels.map((name) => ({ name })), created_at: iso(created), updated_at: iso(later(created, closed, ...is.comments.map((c) => at(c.day, '15:00')))), closed_at: iso(closed), closed_by: closed ? ghUser(is.closedBy) : null, comments: is.comments.length, html_url: null };
      envs.push(...ghMap.issueEnvelopes(SRC('github'), repoPayload, issue));
      is.comments.forEach((c, n) => envs.push(...ghMap.commentEnvelopes(SRC('github'), repoPayload, { id: issue.id * 10 + n, user: ghUser(c.by), body: c.body, created_at: iso(at(c.day, '15:00')), updated_at: iso(at(c.day, '15:00')), html_url: null }, { number: is.number })));
    }
    // Links (merge commits, included commits) are resolved after all records of the batch.
    await run(conn, 'github', res, envs);
  }
  for (const [k, u] of Object.entries(GH_USERS)) {
    await conn.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual', matched_by = ? WHERE provider = 'github' AND source_instance = ? AND external_user_id = ?", [ids.user[k], ids.user.koushik, SRC('github'), String(u.id)]);
  }
  for (const pr of PULLS) ids.record[`pr:${pr.repo}#${pr.number}`] = await recordId(conn, 'github', 'pull_request', `${REPOS.find((x) => x.key === pr.repo).id}#${pr.number}`);
}

// Figma
const figmaUser = (k) => ({ id: `fg-${k}`, handle: P[k].name, email: P[k].email });

async function seedFigma(conn) {
  await connection(conn, 'figma', 'Figma', 'Arclight Labs');
  for (const folder of FIGMA_FOLDERS) {
    const res = await resource(conn, 'figma', { type: 'project', externalId: folder.id, name: folder.name, project: folder.project, metadata: { path: folder.name } });
    const envs = [];
    for (const f of FIGMA_FILES.filter((x) => x.folder === folder.id)) {
      const file = { key: f.key, name: f.name, last_modified: iso(at(f.modified, '18:00')), thumbnail_url: null };
      const meta = { creator: figmaUser(f.owner), last_touched_by: figmaUser(f.lastTouchedBy), last_touched_at: iso(at(f.modified, '18:00')), editorType: 'figma', folder_name: folder.name };
      envs.push(...figmaMap.fileEnvelopes(file, folder.id, meta));
      envs.push(...figmaMap.createdEnvelope(file, { created_at: iso(at(f.created, '11:00')), user: figmaUser(f.owner) }, meta));
      for (const v of f.versions) envs.push(...figmaMap.versionEnvelopes(f.key, { id: v.id, label: v.label, description: v.description, created_at: iso(at(v.day, '17:30')), user: figmaUser(v.by) }));
      for (const c of f.comments) envs.push(...figmaMap.commentEnvelopes(f.key, { id: c.id, user: figmaUser(c.by), message: c.text, created_at: iso(at(c.day, c.at)), resolved_at: c.resolved !== undefined ? iso(at(c.resolved, '18:00')) : null, parent_id: c.replyTo ?? null }));
    }
    await run(conn, 'figma', res, envs);
  }
  for (const f of FIGMA_FILES) {
    ids.record[`figma:${f.key}`] = await recordId(conn, 'figma', 'design_file', f.key);
    for (const c of f.comments) ids.record[`figma-comment:${c.id}`] = await recordId(conn, 'figma', 'comment', c.id);
  }
}

// Microsoft Teams
const teamsIdentity = (k) => ({ type: 'identity', externalUserId: `aad-${k}`, login: P[k].name, displayName: P[k].name, email: P[k].email, isBot: false });

async function seedTeams(conn) {
  await connection(conn, 'microsoft_teams', 'Microsoft Teams', COMPANY);
  for (const ch of TEAMS_CHANNELS) {
    const teamId = `seed-team-${slug(ch.team)}`;
    const channelId = `seed-ch-${ch.key}`;
    const res = await resource(conn, 'microsoft_teams', { type: 'channel', externalId: `${teamId}/${channelId}`, name: `${ch.team} / ${ch.channel}`, project: ch.project, metadata: { teamId, channelId, team: ch.team, channel: ch.channel, membershipType: 'standard' } });
    const envs = [];
    const msg = (m, by, d, t, subject = null) => ({ id: m, messageType: 'message', subject, body: { contentType: 'text', content: null }, from: { user: { id: `aad-${by}`, displayName: P[by].name } }, createdDateTime: iso(at(d, t)), lastModifiedDateTime: iso(at(d, t)), webUrl: null, importance: 'normal', mentions: [] });
    for (const post of TEAMS_POSTS.filter((p) => p.channel === ch.key)) {
      const people = new Set([post.by, ...post.replies.map((x) => x.by)]);
      envs.push(...[...people].map(teamsIdentity));
      const m = msg(post.id, post.by, post.day, post.at, post.subject);
      m.body.content = post.text;
      envs.push(...messageEnvelopes(SRC('microsoft_teams'), channelId, m).filter((e) => e.type !== 'identity'));
      for (const rep of post.replies) {
        const rm = msg(rep.id, rep.by, rep.day, rep.at);
        rm.body.content = rep.text;
        envs.push(...messageEnvelopes(SRC('microsoft_teams'), channelId, rm, post.id).filter((e) => e.type !== 'identity'));
      }
    }
    await run(conn, 'microsoft_teams', res, envs);
    for (const post of TEAMS_POSTS.filter((p) => p.channel === ch.key)) {
      ids.record[`teams:${ch.key}/${post.id}`] = await recordId(conn, 'microsoft_teams', 'message', `${channelId}/${post.id}`);
      for (const rep of post.replies) ids.record[`teams:${ch.key}/${rep.id}`] = await recordId(conn, 'microsoft_teams', 'message', `${channelId}/${rep.id}`);
    }
  }
}

// Outlook (Koushik's mailbox and the shared meetings calendar)
const EMAIL_PROJECT = { m01: 'atlas', m02: 'atlas', m03: 'canvas', m04: 'canvas', m05: 'atlas', m06: 'atlas', m07: 'atlas', m08: 'canvas', m09: 'atlas', m10: 'orion', m11: 'atlas', m12: 'nova', m13: 'sentinel', m14: 'atlas', m15: null };
const addr = (k) => (k.startsWith('ext:') ? { emailAddress: { address: EXTERNAL_PEOPLE[k.slice(4)].email, name: EXTERNAL_PEOPLE[k.slice(4)].name } } : { emailAddress: { address: P[k].email, name: P[k].name } });

async function seedOutlook(conn, meetingUrls) {
  await connection(conn, 'outlook', 'Outlook', P.koushik.email);
  for (const folder of [{ id: 'inbox', name: 'Mail: Inbox' }, { id: 'sent', name: 'Mail: Sent Items' }]) {
    const res = await resource(conn, 'outlook', { type: 'mail_folder', externalId: `seed-folder-${folder.id}`, name: folder.name, metadata: { items: EMAILS.filter((e) => e.folder === folder.id).length } });
    const envs = [];
    for (const e of EMAILS.filter((x) => x.folder === folder.id)) {
      const when = at(e.day, e.at);
      const m = { id: `seed-mail-${e.id}`, subject: e.subject, from: addr(e.from), toRecipients: e.to.map(addr), ccRecipients: e.cc.map(addr), receivedDateTime: iso(when), lastModifiedDateTime: iso(when), bodyPreview: e.body, webLink: null, conversationId: `seed-conv-${e.thread}`, importance: e.importance, categories: [], isDraft: false };
      for (const env of emailEnvelopes(SRC('outlook'), `seed-folder-${folder.id}`, m)) {
        if (env.type === 'record' && e.attachments) env.metadata = { ...env.metadata, attachments: e.attachments };
        envs.push(env);
      }
    }
    await run(conn, 'outlook', res, envs);
  }
  const cal = await resource(conn, 'outlook', { type: 'calendar', externalId: 'seed-calendar-meetings', name: `Calendar: ${COMPANY} meetings`, metadata: { default: false } });
  const envs = [];
  for (const m of [...MEETINGS, ...UPCOMING_MEETINGS]) {
    const start = at(m.day, m.time);
    const end = at(m.day, m.time, m.minutes);
    const ev = {
      id: `seed-evt-${m.key}`, subject: m.title, bodyPreview: m.agenda, start: { dateTime: iso(start).replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: iso(end).replace('Z', ''), timeZone: 'UTC' },
      organizer: addr(m.organizer), attendees: m.attendees.map(addr), isCancelled: false, isOnlineMeeting: true, onlineMeeting: { joinUrl: meetingUrls[m.key] }, webLink: null,
      location: { displayName: m.platform === 'teams' ? 'Microsoft Teams Meeting' : 'Google Meet' }, createdDateTime: iso(later(at(Math.min(m.day - 4, -2), '09:00'), at(P[m.organizer].joined))), lastModifiedDateTime: iso(at(Math.min(m.day - 4, -2), '09:00')), type: 'singleInstance',
    };
    envs.push(...eventEnvelopes(SRC('outlook'), 'seed-calendar-meetings', ev, NOW));
  }
  await run(conn, 'outlook', cal, envs);
  for (const e of EMAILS) {
    const id = await recordId(conn, 'outlook', 'email', `seed-mail-${e.id}`);
    ids.record[`email:${e.id}`] = id;
    if (EMAIL_PROJECT[e.id]) {
      await conn.execute('UPDATE external_records SET project_id = ?, project_locked = TRUE WHERE id = ?', [ids.project[EMAIL_PROJECT[e.id]], id]);
      await activitiesRepo.syncProjectForRecord(conn, id, ids.project[EMAIL_PROJECT[e.id]]);
    }
  }
  for (const m of [...MEETINGS, ...UPCOMING_MEETINGS]) {
    const id = await recordId(conn, 'outlook', 'calendar_event', `seed-evt-${m.key}`);
    ids.record[`event:${m.key}`] = id;
    if (m.project) {
      await conn.execute('UPDATE external_records SET project_id = ?, project_locked = TRUE WHERE id = ?', [ids.project[m.project], id]);
      await activitiesRepo.syncProjectForRecord(conn, id, ids.project[m.project]);
    }
  }
}

// ---- 3. meetings, transcripts, decisions, action items ------------------------------------------

function meetCode(key) {
  const h = hexOf(key, 20);
  const letters = [...h].map((c) => String.fromCharCode(97 + (parseInt(c, 16) % 26))).join('');
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7, 10)}`;
}
const meetingUrl = (m) => (m.platform === 'teams' ? `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${hexOf(m.key, 32)}%40thread.v2/0` : `https://meet.google.com/${meetCode(m.key)}`);
const nativeId = (m) => (m.platform === 'teams' ? `19:meeting_${hexOf(m.key, 32)}@thread.v2` : meetCode(m.key));

function segmentsOf(m) {
  const r = rng(m.day * -97 + m.title.length);
  let t = 20 + Math.floor(r() * 25);
  return m.transcript.map(([who, text], n) => {
    const words = text.split(/\s+/).length;
    const dur = Math.max(2.4, words / (2.3 + r() * 0.7));
    const seg = { sourceId: `seg-${String(n + 1).padStart(3, '0')}`, speaker: P[who].name, text, startSec: Math.round(t * 100) / 100, endSec: Math.round((t + dur) * 100) / 100, language: 'en', confidence: Math.round((0.9 + r() * 0.08) * 1000) / 1000 };
    t += dur + 0.6 + r() * 2.2;
    return seg;
  });
}

const reviewer = (m) => (m.project ? PROJ[m.project].owner : 'koushik');

/** Times of an item's life, never before it was created and never in the future. */
function itemTimeline(i, createdAt, approvedAt) {
  const r = rng(i.key.length * 7919 + (i.due ?? 0) * 31 + (i.started ?? 0));
  const startedAt = i.started !== undefined ? notAfterNow(later(at(i.started, '10:30', Math.floor(r() * 300)), new Date((approvedAt ?? createdAt).getTime() + 15 * MIN))) : null;
  const doneAt = i.done !== undefined ? notAfterNow(later(at(i.done, '16:00', Math.floor(r() * 150)), new Date((startedAt ?? approvedAt ?? createdAt).getTime() + 40 * MIN))) : null;
  const blockedAt = i.status === 'blocked' ? notAfterNow(later(new Date(startedAt.getTime() + 26 * HOUR), at(Math.min((i.started ?? 0) + 3, -1), '12:00'))) : null;
  return { startedAt, doneAt, blockedAt, updatedAt: later(createdAt, approvedAt, startedAt, doneAt, blockedAt) };
}

async function insertItem(conn, i, { meetingId = null, projectKey, runId = null, sourceType, sourceRecordId = null, createdAt, approvedAt, approver }) {
  const owner = P[i.owner];
  const team = primaryTeam(i.owner);
  const review = i.review ?? 'approved';
  const tl = itemTimeline(i, createdAt, review === 'approved' ? approvedAt : null);
  const deadlineStatus = i.due !== undefined && i.due !== null ? 'resolved' : i.dueRaw ? 'needs_clarification' : 'none';
  const flags = i.flags ?? (deadlineStatus === 'none' && review === 'pending' ? ['missing_deadline'] : []);
  const [res] = await conn.execute(
    `INSERT INTO action_items (meeting_id, project_id, team_id, department_id, extraction_run_id, source_type, source_record_id, title, description, category,
       assignee_name_raw, assignee_user_id, assignee_match, assignee_kind, due_date, due_date_raw, deadline_status, due_timezone, priority,
       review_status, task_status, flags, review_details, ai_confidence, approved_by, approved_at, created_by, execution_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', 'explicit', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'none', ?, ?)`,
    [
      meetingId, projectKey ? ids.project[projectKey] : null, team ? ids.team[team.key] : null, ids.dept[owner.dept], runId, sourceType, sourceRecordId, i.title, i.description, i.category,
      owner.name, ids.user[i.owner], i.due !== undefined && i.due !== null ? day(i.due) : null, i.dueRaw ?? null, deadlineStatus, OFFICE_TZ, i.priority,
      review, review === 'approved' ? i.status : 'todo', json(flags), json({ seeded: true, dataset: COMPANY, assigneeCandidates: [{ userId: ids.user[i.owner], name: owner.name, match: 'exact' }] }),
      review === 'approved' ? ids.user[approver] : null, review === 'approved' ? approvedAt : null, createdAt, review === 'approved' ? tl.updatedAt : createdAt,
    ],
  );
  ids.item[i.key] = res.insertId;
  await register(conn, 'action_item', res.insertId, `item:${i.key}`);
  return { id: res.insertId, tl, review };
}

async function itemHistory(conn, i, id, tl, review, approvedAt, approver) {
  if (review === 'rejected') {
    await historical(conn, { when: approvedAt, actor: approver, action: 'action_item.rejected', entityType: 'action_item', entityId: id, after: { reviewStatus: 'rejected', reason: 'Descoped in review' } });
    return;
  }
  if (review !== 'approved') return;
  if (tl.startedAt) await historical(conn, { when: tl.startedAt, actor: i.owner, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: 'todo' }, after: { taskStatus: 'in_progress' } });
  if (tl.blockedAt) await historical(conn, { when: tl.blockedAt, actor: i.owner, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: 'in_progress' }, after: { taskStatus: 'blocked' } });
  if (tl.doneAt) await historical(conn, { when: tl.doneAt, actor: i.owner, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: tl.startedAt ? 'in_progress' : 'todo' }, after: { taskStatus: 'done' } });
}

async function seedMeetings(conn, meetingUrls, events) {
  let vexaId = 1400;
  for (const m of [...MEETINGS, ...UPCOMING_MEETINGS]) {
    const start = at(m.day, m.time);
    const end = at(m.day, m.time, m.minutes + (m.transcript ? 2 : 0));
    const createdAt = later(at(Math.min(m.day - 4, -2), '09:30'), at(P[m.organizer].joined, '10:00'));
    const upcoming = !m.transcript;
    const google = m.platform === 'google_meet';
    const [res] = await conn.execute(
      `INSERT INTO meetings (title, project_id, meeting_url, platform, native_meeting_id, vexa_meeting_id, bot_status, bot_requested_at, bot_checked_at, scheduled_at, started_at, ended_at, status, language_hint, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en', ?, ?, ?)`,
      [m.title, m.project ? ids.project[m.project] : null, meetingUrls[m.key], m.platform, nativeId(m), !upcoming && google ? String(++vexaId) : null, !upcoming && google ? 'completed' : null,
        !upcoming && google ? new Date(start.getTime() - 2 * MIN) : null, !upcoming && google ? new Date(end.getTime() + 4 * MIN) : null, start, upcoming ? null : new Date(start.getTime() + MIN), upcoming ? null : end,
        upcoming ? 'draft' : m.status, ids.user[m.organizer], createdAt, upcoming ? createdAt : new Date(end.getTime() + 50 * MIN)],
    );
    const meetingId = res.insertId;
    ids.meeting[m.key] = meetingId;
    await register(conn, 'meeting', meetingId, `meeting:${m.key}`, { agenda: m.agenda });
    for (const a of m.attendees) await conn.execute('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)', [meetingId, ids.user[a]]);
    events.push({ when: createdAt, actor: m.organizer, action: 'meeting.created', entityType: 'meeting', entityId: meetingId, after: { title: m.title } });
    if (upcoming) continue;

    // Transcript
    const segments = segmentsOf(m);
    const raw = google
      ? { source: 'vexa', format: 'vexa_json', filename: null, vexaMeetingId: String(vexaId), platform: 'google_meet', nativeMeetingId: nativeId(m) }
      : { source: 'manual_upload', format: 'vtt', filename: `${slug(m.title)}.vtt`, uploadedBy: ids.user[m.organizer] };
    const fetchedAt = new Date(end.getTime() + 3 * MIN);
    const [t] = await conn.execute('INSERT INTO transcripts (meeting_id, full_text, raw_json, detected_languages, segment_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', [meetingId, renderFullText(segments), json(raw), json(['en']), segments.length, fetchedAt]);
    await conn.query('INSERT INTO transcript_segments (transcript_id, vexa_segment_id, speaker, text, start_sec, end_sec, language, confidence) VALUES ?', [segments.map((s) => [t.insertId, s.sourceId, s.speaker, s.text, s.startSec, s.endSec, s.language, s.confidence])]);
    const [segRows] = await conn.query('SELECT id FROM transcript_segments WHERE transcript_id = ? ORDER BY id', [t.insertId]);
    const segId = segRows.map((r) => r.id);
    events.push({ when: fetchedAt, actor: google ? null : m.organizer, action: google ? 'transcript.imported_from_vexa' : 'transcript.uploaded', entityType: 'meeting', entityId: meetingId, after: { segments: segments.length } });

    // Extraction run (recorded as seeded data: no model was called)
    const runAt = new Date(end.getTime() + 5 * MIN);
    const [run] = await conn.execute(
      "INSERT INTO extraction_runs (meeting_id, requested_by, model, prompt_version, status, attempts, input_tokens, output_tokens, summary, created_at, started_at, finished_at) VALUES (?, ?, 'seed-dataset', 'seed', 'succeeded', 1, NULL, NULL, ?, ?, ?, ?)",
      [meetingId, ids.user[m.organizer], json({ items: m.items.length, decisions: m.decisions.length, note: 'Seeded development data; no AI model was called.' }), runAt, runAt, new Date(runAt.getTime() + MIN)],
    );
    for (const d of m.decisions) {
      await conn.execute('INSERT INTO meeting_decisions (meeting_id, text, decided_by_name, decided_by_user_id, evidence, segment_id, start_sec, ai_provider, ai_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)', [
        meetingId, d.text, P[d.by].name, ids.user[d.by], m.transcript[d.line][1], segId[d.line], segments[d.line].startSec, new Date(runAt.getTime() + MIN),
      ]);
    }

    // Action items with transcript evidence
    const approver = reviewer(m);
    const createdItems = new Date(runAt.getTime() + MIN);
    const approvedAt = new Date(end.getTime() + 40 * MIN);
    for (const i of m.items) {
      const { id, tl, review } = await insertItem(conn, i, { meetingId, projectKey: m.project, runId: run.insertId, sourceType: 'meeting', createdAt: createdItems, approvedAt, approver });
      const s = segments[i.line];
      await conn.execute("INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, start_sec, segment_id, occurred_at, relation) VALUES (?, ?, ?, ?, ?, ?, 'origin')", [id, s.text, s.speaker, s.startSec, segId[i.line], new Date(start.getTime() + s.startSec * 1000)]);
      events.push({ item: i, id, tl, review, approvedAt, approver, sortAt: approvedAt });
    }
    if (['approved', 'emails_sent'].includes(m.status)) {
      events.push({ when: approvedAt, actor: approver, action: 'meeting.review_completed', entityType: 'meeting', entityId: meetingId, after: { approved: m.items.filter((i) => (i.review ?? 'approved') === 'approved').length } });
    } else {
      events.push({ reviewRequest: m, meetingId, when: new Date(runAt.getTime() + 2 * MIN) });
    }
  }
}

const sourceRecordFor = (s) => {
  if (s.type === 'jira_comment') return ids.record[`jira-comment:${s.issue}:${s.comment}`];
  if (s.type === 'github_comment') return ids.record[`gh-review:${s.pr}:${s.review}`];
  if (s.type === 'figma_comment') return ids.record[`figma-comment:${s.comment}`];
  if (s.type === 'teams_message') return ids.record[`teams:${s.channel}/${s.reply ?? s.post}`];
  return ids.record[`email:${s.email}`];
};

async function seedSourceItems(conn, events) {
  // Records that carry the source text of each item.
  for (const i of JIRA_ISSUES) for (const [n] of (i.comments ?? []).entries()) ids.record[`jira-comment:${i.key}:${n}`] = await recordId(conn, 'jira', 'comment', `${ISSUE[i.key].id}${String(n + 1).padStart(2, '0')}`);
  for (const pr of PULLS) {
    for (const [n] of pr.reviews.entries()) ids.record[`gh-review:${pr.repo}#${pr.number}:${n}`] = await recordId(conn, 'github', 'review', pr.number * 1000 + n + 1);
  }
  for (const i of SOURCE_ITEMS) {
    const recId = sourceRecordFor(i.source);
    if (!recId) throw new Error(`source record not found for ${i.key}`);
    const [[rec]] = await conn.query('SELECT r.body, r.source_created_at, i.display_name FROM external_records r LEFT JOIN external_identities i ON i.id = r.author_identity_id WHERE r.id = ?', [recId]);
    const createdAt = new Date(new Date(rec.source_created_at).getTime() + 25 * MIN);
    const approver = PROJ[i.project].owner === i.owner ? 'koushik' : PROJ[i.project].owner;
    const approvedAt = new Date(createdAt.getTime() + 2 * HOUR);
    const sourceType = i.source.type;
    const { id, tl, review } = await insertItem(conn, i, { projectKey: i.project, sourceType, sourceRecordId: recId, createdAt, approvedAt, approver });
    await conn.execute("INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, record_id, occurred_at, relation) VALUES (?, ?, ?, ?, ?, 'origin')", [id, String(rec.body).slice(0, 2000), rec.display_name, recId, rec.source_created_at]);
    await conn.execute("INSERT INTO action_source_scans (record_id, content_hash, status, items_created, items_linked, reason, analysed_at) VALUES (?, ?, 'analysed', 1, 0, 'Seeded development data', ?) ON DUPLICATE KEY UPDATE items_created = items_created + 1", [recId, hexOf(`scan:${recId}`, 64), createdAt]);
    if (review === 'approved') events.push({ when: approvedAt, actor: approver, action: 'action_item.approved', entityType: 'action_item', entityId: id, after: { reviewStatus: 'approved', sourceType } });
    else events.push({ sourceReview: i, id, when: new Date(createdAt.getTime() + MIN) });
    events.push({ item: i, id, tl, review, approvedAt, approver, sortAt: approvedAt });
  }
}

// ---- 4. links and cross-source evidence ---------------------------------------------------------

const EXTRA_EVIDENCE = [
  { item: 'atlas-notif-idempotency', record: 'teams:atlas-project/p-a1', relation: 'completion' },
  { item: 'ready-dup-fix', record: 'teams:orion-automation/p-o3', relation: 'supporting' },
  { item: 'timeline-retry-tooltip', record: 'figma-comment:7700105', relation: 'completion' },
  { item: 'timeline-compact', record: 'figma-comment:7700104', relation: 'completion' },
  { item: 'overview-contrast', record: 'figma-comment:7710102', relation: 'supporting' },
  { item: 'nova-arch-pii', record: 'email:m12', relation: 'progress' },
  { item: 'rel-staging-capacity', record: 'email:m11', relation: 'progress' },
  { item: 'atlas-notif-guarantees', record: 'email:m01', relation: 'supporting' },
  { item: 'overview-timeline-component', record: 'email:m08', relation: 'completion' },
  { item: 's5-ratelimit-numbers', record: 'teams:atlas-project/p-a2', relation: 'supporting' },
  { item: 'cov-timeouts', record: 'teams:quality-assurance/p-q2', relation: 'progress' },
  { item: 'inc-customer', record: 'email:m07', relation: 'completion' },
  { item: 'port-pilot-update', record: 'email:m06', relation: 'completion' },
  { item: 'q4-publish', record: 'email:m15', relation: 'supporting' },
];

async function seedLinks(conn) {
  const allItems = [...MEETINGS.flatMap((m) => m.items.map((i) => ({ ...i, meeting: m.key }))), ...SOURCE_ITEMS];
  let links = 0;
  const link = async (from, to, linkType, createdBy) => {
    const r = await createLink(conn, { from, to, linkType, origin: 'manual', createdBy: ids.user[createdBy] });
    if (r.inserted) links += 1;
  };
  for (const i of allItems) {
    const itemRef = { type: 'action_item', id: ids.item[i.key] };
    if (i.jira) await link(itemRef, { type: 'external_record', id: ids.record[`jira:${i.jira}`] }, 'tracks', i.owner);
    if (i.blockedBy) await link({ type: 'action_item', id: ids.item[i.blockedBy] }, itemRef, 'blocks', i.owner);
    // Pull requests that implement the tracked issue are the progress / completion evidence.
    if (i.jira && (i.review ?? 'approved') === 'approved') {
      for (const pr of PULLS.filter((x) => x.jira.includes(i.jira))) {
        const recId = ids.record[`pr:${pr.repo}#${pr.number}`];
        const merged = pr.merged !== undefined;
        const relation = merged && i.status === 'done' ? 'completion' : 'progress';
        const [[rec]] = await conn.query('SELECT source_updated_at FROM external_records WHERE id = ?', [recId]);
        await conn.execute('INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, record_id, occurred_at, relation) VALUES (?, ?, ?, ?, ?, ?)', [
          ids.item[i.key], `${merged ? 'Merged' : 'Open'} pull request ${GH_ORG}/${pr.repo}#${pr.number}: ${pr.title}`, P[pr.author].name, recId, rec.source_updated_at, relation,
        ]);
      }
    }
  }
  for (const e of EXTRA_EVIDENCE) {
    const recId = ids.record[e.record];
    const [[rec]] = await conn.query('SELECT r.body, r.title, r.source_created_at, i.display_name FROM external_records r LEFT JOIN external_identities i ON i.id = r.author_identity_id WHERE r.id = ?', [recId]);
    await conn.execute('INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, record_id, occurred_at, relation) VALUES (?, ?, ?, ?, ?, ?)', [ids.item[e.item], String(rec.body ?? rec.title).slice(0, 2000), rec.display_name, recId, rec.source_created_at, e.relation]);
  }
  for (const pr of PULLS) for (const j of pr.jira) await link({ type: 'external_record', id: ids.record[`pr:${pr.repo}#${pr.number}`] }, { type: 'external_record', id: ids.record[`jira:${j}`] }, 'implements', pr.author);
  for (const m of MEETINGS) {
    for (const j of new Set(m.items.map((i) => i.jira).filter(Boolean))) await link({ type: 'external_record', id: ids.record[`jira:${j}`] }, { type: 'meeting', id: ids.meeting[m.key] }, 'discussed_in', m.organizer);
  }
  for (const m of [...MEETINGS, ...UPCOMING_MEETINGS]) await link({ type: 'external_record', id: ids.record[`event:${m.key}`] }, { type: 'meeting', id: ids.meeting[m.key] }, 'same_as', m.organizer);
  for (const f of FIGMA_FILES) {
    const related = { AtLsWs8kD2qPzE: ['ATL-102', 'ATL-108'], CnVsOv3rV1ew9T: ['CAN-112', 'CAN-113', 'CAN-115'], NvAiNt3lL1g4cX: ['NOV-406'], OrNaPpR0v4lX7Q: ['ORI-205'] }[f.key] ?? [];
    for (const j of related) await link({ type: 'external_record', id: ids.record[`figma:${f.key}`] }, { type: 'external_record', id: ids.record[`jira:${j}`] }, 'related', f.owner);
  }
  await conn.execute('UPDATE record_links SET created_at = ?, updated_at = ? WHERE created_at >= ?', [at(-1, '20:00'), at(-1, '20:00'), new Date(NOW.getTime() - HOUR)]);
  return links;
}

// ---- 5. history (audit → activities, notifications) in time order ------------------------------

async function seedHistory(conn, events) {
  for (const p of PROJECTS) events.push({ when: at(p.start, '09:15'), actor: 'koushik', action: 'project.created', entityType: 'project', entityId: ids.project[p.key], after: { name: p.name, status: 'active' } });
  events.push({ when: at(-12, '18:00'), actor: 'keerthan', action: 'project.status_changed', entityType: 'project', entityId: ids.project.pulse, before: { name: PROJ.pulse.name, status: 'active' }, after: { name: PROJ.pulse.name, status: 'completed' } });
  const timeline = [];
  for (const e of events) {
    if (e.item) {
      const { item: i, id, tl, review, approvedAt, approver } = e;
      if (review === 'rejected') timeline.push({ when: approvedAt, run: () => itemHistory(conn, i, id, tl, review, approvedAt, approver) });
      if (tl.startedAt) timeline.push({ when: tl.startedAt, run: () => historical(conn, { when: tl.startedAt, actor: i.owner, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: 'todo' }, after: { taskStatus: 'in_progress' } }) });
      if (tl.blockedAt) timeline.push({ when: tl.blockedAt, run: () => historical(conn, { when: tl.blockedAt, actor: i.owner, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: 'in_progress' }, after: { taskStatus: 'blocked' } }) });
      if (tl.doneAt && review === 'approved') timeline.push({ when: tl.doneAt, run: () => historical(conn, { when: tl.doneAt, actor: i.owner, action: 'task.status_changed', entityType: 'action_item', entityId: id, before: { taskStatus: tl.startedAt ? 'in_progress' : 'todo' }, after: { taskStatus: 'done' } }) });
    } else if (e.reviewRequest) {
      const m = e.reviewRequest;
      const owner = reviewer(m);
      timeline.push({ when: e.when, run: async () => {
        const [[{ maxNotif }]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS maxNotif FROM notifications');
        await notify(conn, { userId: ids.user[owner], kind: 'action_review', title: `${m.items.length} action items from “${m.title}” need review`, body: 'The transcript is ready and the extracted items are waiting for your review.', link: `/admin/meetings/${e.meetingId}`, entityType: 'meeting', entityId: e.meetingId, dedupeKey: `meeting-review:${e.meetingId}` });
        if (owner !== 'koushik') await notify(conn, { userId: ids.user.koushik, kind: 'action_review', title: `${m.items.length} action items from “${m.title}” need review`, link: `/admin/meetings/${e.meetingId}`, entityType: 'meeting', entityId: e.meetingId, dedupeKey: `meeting-review:${e.meetingId}` });
        await datedNotifications(conn, maxNotif, e.when);
      } });
    } else if (e.sourceReview) {
      const i = e.sourceReview;
      const owner = PROJ[i.project].owner === i.owner ? 'koushik' : PROJ[i.project].owner;
      timeline.push({ when: e.when, run: async () => {
        const [[{ maxNotif }]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS maxNotif FROM notifications');
        await notify(conn, { userId: ids.user[owner], kind: 'action_review', title: `New action item from ${{ teams_message: 'Microsoft Teams', outlook_email: 'Outlook', jira_comment: 'Jira', github_comment: 'GitHub', figma_comment: 'Figma' }[i.source.type]} needs review`, body: i.title, link: `/actions/${e.id}`, entityType: 'action_item', entityId: e.id, dedupeKey: `source-review:${e.id}` });
        await datedNotifications(conn, maxNotif, e.when);
      } });
    } else {
      timeline.push({ when: e.when, run: () => historical(conn, e) });
    }
  }
  timeline.sort((a, b) => a.when - b.when);
  for (const t of timeline) await t.run();
  return timeline.length;
}

// ---- 6. approvals and executions through the execution engine ----------------------------------

const userObj = (k) => ({ id: ids.user[k], email: P[k].email, fullName: P[k].name, role: P[k].role });

async function backdatePlan(planId, { created, approved = null, executed = null }) {
  await pool.execute('UPDATE action_plans SET created_at = ?, approved_at = COALESCE(?, approved_at), updated_at = ? WHERE id = ?', [created, approved, executed ?? approved ?? created, planId]);
  await pool.execute('UPDATE action_executions SET created_at = ?, executed_at = IF(executed_at IS NULL, NULL, ?), verified_at = IF(verified_at IS NULL, NULL, ?), updated_at = ? WHERE plan_id = ?', [created, executed, executed, executed ?? approved ?? created, planId]);
  await pool.execute("UPDATE audit_logs SET created_at = ? WHERE entity_type = 'action_plan' AND entity_id = ? AND action = 'action_plan.prepared'", [created, planId]);
  if (approved) await pool.execute("UPDATE audit_logs SET created_at = ? WHERE entity_type = 'action_plan' AND entity_id = ? AND action = 'action_plan.approved'", [approved, planId]);
  await pool.execute("UPDATE audit_logs SET created_at = ? WHERE entity_type = 'action_plan' AND entity_id = ? AND action NOT IN ('action_plan.prepared', 'action_plan.approved')", [executed ?? approved ?? created, planId]);
  const [execs] = await pool.query('SELECT id FROM action_executions WHERE plan_id = ?', [planId]);
  if (execs.length) await pool.query("UPDATE audit_logs SET created_at = ? WHERE entity_type = 'action_execution' AND entity_id IN (?)", [executed ?? approved ?? created, execs.map((x) => x.id)]);
  await pool.execute("UPDATE notifications SET created_at = ? WHERE entity_type = 'action_plan' AND entity_id = ?", [executed ?? created, planId]);
}

async function seedApprovals() {
  const item = (k) => ids.item[k];
  const plans = [];
  const maxNotif = async () => Number((await pool.query('SELECT COALESCE(MAX(id), 0) AS n FROM notifications'))[0][0].n);
  const prepare = async (requester, keys, options) => {
    const out = await engine.prepare(userObj(requester), { kind: 'workagent.notify', actionItemIds: keys.map(item), options });
    if (!out.planId) throw new Error(`plan for ${keys.join(', ')} could not be prepared: ${JSON.stringify(out.preview.blockers)} ${JSON.stringify(out.preview.drafts.map((d) => d.skipped))}`);
    plans.push(out.planId);
    return out;
  };
  // Approved and executed by the engine (in-app notifications to the owners).
  const executed = async (requester, approver, keys, options, { created, approved, done }) => {
    const p = await prepare(requester, keys, options);
    const before = await maxNotif();
    await engine.approve(userObj(approver), p.planId, { previewHash: p.previewHash });
    await engine.runPlan(p.planId);
    const old = NOW - done > 4 * 86_400_000;
    await pool.execute('UPDATE notifications SET created_at = ?, read_at = ? WHERE id > ?', [done, old ? new Date(done.getTime() + 2 * HOUR) : null, before]);
    await backdatePlan(p.planId, { created, approved, executed: done });
    return p.planId;
  };
  await executed('keerthan', 'keerthan', ['s5-mentions-bug', 's5-sso-admin'], { template: 'assignment', note: 'Carry-over from the Sprint 5 review: these are the two Atlas items the pilots will notice first.' }, { created: at(-36, '10:10'), approved: at(-36, '10:14'), done: at(-36, '10:16') });
  await executed('keerthan', 'koushik', ['rel-sso-docs', 'rel-gate', 'rel-onboarding-pack'], { template: 'assignment', note: 'Atlas 2.0 beta checklist (ATL-116): your line has an owner and a date — please keep it current.' }, { created: at(-15, '09:20'), approved: at(-15, '11:01'), done: at(-15, '11:02') });

  // Rejected before approval.
  const p3 = await prepare('koushik', ['s5-digest-tz'], { template: 'reminder', note: 'The logistics pilot asked about the digest time again.' });
  await engine.reject(userObj('keerthan'), p3.planId, { reason: 'Backlog item until the SSO documentation is done — agreed in the Application Development sync.' });
  await backdatePlan(p3.planId, { created: at(-10, '15:00'), executed: at(-10, '16:20') });

  // Cancelled by the requester before approval.
  const p4 = await prepare('kavya', ['retro-staging-data'], { template: 'reminder', note: 'Test data management is now blocking the nightly suite (SEN-306).' });
  await engine.cancel(userObj('kavya'), p4.planId);
  await backdatePlan(p4.planId, { created: at(-12, '09:40'), executed: at(-12, '09:55') });

  // Approved, then failed with retry information. The engine's transitions are applied directly
  // (no job is queued, so the worker cannot run it): awaiting_approval -> scheduled -> executing ->
  // retry_required after five attempts. Nothing was delivered.
  const p5 = await prepare('anjana', ['cov-sen305'], { template: 'reminder', note: 'SEN-305 gates Orion GA — twenty consecutive green runs needed.' });
  const failedAt = at(-6, '17:40');
  await pool.execute("UPDATE action_plans SET status = 'failed', approved_by = ?, approved_at = ?, approval_basis = 'user' WHERE id = ?", [ids.user.anjana, at(-6, '17:34'), p5.planId]);
  await pool.execute("UPDATE action_executions SET status = 'retry_required', attempts = 5, next_attempt_at = NULL, last_error = ? WHERE plan_id = ?", ['The recipient\'s notification settings could not be read (database lock wait timeout) on 5 attempts. Nothing was delivered; retry when ready.', p5.planId]);
  await pool.execute("UPDATE action_items SET execution_status = 'retry_required' WHERE id = ?", [item('cov-sen305')]);
  const [[p5row]] = await pool.query('SELECT title FROM action_plans WHERE id = ?', [p5.planId]);
  const [[x5]] = await pool.query('SELECT id FROM action_executions WHERE plan_id = ?', [p5.planId]);
  for (const [action, entityType, entityId, when, after] of [
    ['action_plan.approved', 'action_plan', p5.planId, at(-6, '17:34'), { kind: 'workagent.notify', executions: 1 }],
    ['action_execution.retry_required', 'action_execution', x5.id, failedAt, { attempts: 5 }],
    ['action_plan.failed', 'action_plan', p5.planId, failedAt, { succeeded: 0, failed: 1 }],
  ]) await pool.execute('INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [action === 'action_plan.approved' ? ids.user.anjana : null, action, entityType, entityId, json(after), when]);
  await notify(pool, { userId: ids.user.anjana, kind: 'action_execution', title: `1 of 1 actions failed: ${p5row.title}`, body: 'Open the plan to see the error and retry.', link: `/approvals?plan=${p5.planId}`, entityType: 'action_plan', entityId: p5.planId, dedupeKey: `plan-failed:${p5.planId}:1` });
  await backdatePlan(p5.planId, { created: at(-6, '17:30'), approved: at(-6, '17:34'), executed: failedAt });

  // Awaiting approval: nothing runs until someone approves.
  const pending = [
    ['meera', ['nova-arch-pii', 'nova-kick-labels'], 'Both are past due, and the Nova model evaluation review is next Monday.', at(-1, '16:00')],
    ['kavya', ['ready-dup-fix', 'ready-runbook'], 'The GA checkpoint is on Friday — ORI-211 and the rollout runbook decide the date.', at(-1, '11:30')],
    ['keerthan', ['rel-staging-capacity', 's5-ratelimit-numbers'], 'The Atlas go/no-go is on Wednesday and the load test still cannot run.', at(-1, '18:45')],
  ];
  for (const [requester, keys, note, created] of pending) {
    const p = await prepare(requester, keys, { template: 'reminder', note });
    await backdatePlan(p.planId, { created });
    const [[row]] = await pool.query('SELECT title FROM action_plans WHERE id = ?', [p.planId]);
    const before = await maxNotif();
    await notify(pool, { userId: ids.user.koushik, kind: 'action_execution', title: 'A plan is waiting for your approval', body: row.title, link: `/approvals?plan=${p.planId}`, entityType: 'action_plan', entityId: p.planId, dedupeKey: `plan-pending:${p.planId}` });
    await pool.execute('UPDATE notifications SET created_at = ? WHERE id > ?', [new Date(created.getTime() + MIN), before]);
  }
  return plans;
}

/** The inbox lists by id: renumber notifications in time order (nothing references their ids). */
async function chronologicalNotifications() {
  await withTransaction(async (conn) => {
    await conn.query('CREATE TEMPORARY TABLE seed_notif AS SELECT user_id, kind, title, body, link, entity_type, entity_id, dedupe_key, read_at, created_at FROM notifications');
    await conn.query('DELETE FROM notifications');
    await conn.query('ALTER TABLE notifications AUTO_INCREMENT = 1');
    await conn.query('INSERT INTO notifications (user_id, kind, title, body, link, entity_type, entity_id, dedupe_key, read_at, created_at) SELECT user_id, kind, title, body, link, entity_type, entity_id, dedupe_key, read_at, created_at FROM seed_notif ORDER BY created_at, dedupe_key');
    await conn.query('DROP TEMPORARY TABLE seed_notif');
  });
}

// ---- 7. manifest ----------------------------------------------------------------------------------

async function manifest() {
  const count = async (sql, p = []) => Number((await pool.query(sql, p))[0][0].n);
  const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY 1");
  const rows = [];
  for (const { t } of tables) rows.push([t, await count(`SELECT COUNT(*) AS n FROM \`${t}\``)]);
  const [records] = await pool.query("SELECT provider, record_type, COUNT(*) AS n FROM external_records WHERE source_instance LIKE 'seed.%' GROUP BY 1, 2 ORDER BY 1, 2");
  const [items] = await pool.query('SELECT review_status, task_status, COUNT(*) AS n FROM action_items GROUP BY 1, 2 ORDER BY 1, 2');
  const [plans] = await pool.query('SELECT status, COUNT(*) AS n FROM action_plans GROUP BY 1');
  const overdue = await count("SELECT COUNT(*) AS n FROM action_items WHERE review_status = 'approved' AND task_status <> 'done' AND due_date < ?", [day(0)]);
  const lines = [
    '# Seed data manifest',
    '',
    `Generated by \`npm run db:seed\` (backend) on ${new Date().toISOString()} — anchor day ${ANCHOR}, company ${COMPANY}, domain ${DOMAIN}. Regenerated on every seed; do not edit by hand.`,
    '',
    '## People',
    '',
    '| Name | E-mail | Title | Department | Team | Reports to | Role | Joined | Skills |',
    '|---|---|---|---|---|---|---|---|---|',
    ...PEOPLE.map((p) => `| ${p.name} | ${p.email} | ${p.title} | ${DEPARTMENTS.find((d) => d.key === p.dept).name} | ${primaryTeam(p.key)?.name ?? '—'} | ${p.manager ? P[p.manager].name : '—'} | ${p.role} | ${day(p.joined)} | ${p.skills.join(', ')} |`),
    '',
    '## Projects',
    '',
    '| Project | Owner | Status | Priority | Start | Target | Jira | Repository |',
    '|---|---|---|---|---|---|---|---|',
    ...PROJECTS.map((p) => `| ${p.name} | ${P[p.owner].name} | ${p.status} | ${p.priority} | ${day(p.start)} | ${day(p.target)} | ${p.jiraKey} | ${GH_ORG}/${p.repo} |`),
    '',
    '## Meetings',
    '',
    '| Date | Meeting | Project | Status | Transcript lines | Action items | Decisions |',
    '|---|---|---|---|---|---|---|',
    ...[...MEETINGS, ...UPCOMING_MEETINGS].sort((a, b) => a.day - b.day).map((m) => `| ${day(m.day)} | ${m.title} | ${m.project ? PROJ[m.project].name.split(' —')[0] : 'Leadership'} | ${m.transcript ? m.status : 'scheduled'} | ${m.transcript?.length ?? 0} | ${m.items?.length ?? 0} | ${m.decisions?.length ?? 0} |`),
    '',
    '## Action items by review and task status',
    '',
    '| Review | Task | Count |',
    '|---|---|---|',
    ...items.map((r) => `| ${r.review_status} | ${r.task_status} | ${r.n} |`),
    '',
    `Overdue (approved, open, due before ${day(0)}): ${overdue}`,
    '',
    '## Approval plans',
    '',
    ...plans.map((r) => `- ${r.status}: ${r.n}`),
    '',
    '## Seeded integration records',
    '',
    '| Provider | Record type | Count |',
    '|---|---|---|',
    ...records.map((r) => `| ${r.provider} | ${r.record_type} | ${r.n} |`),
    '',
    '## Rows per table',
    '',
    '| Table | Rows |',
    '|---|---|',
    ...rows.map(([t, n]) => `| ${t} | ${n} |`),
    '',
  ];
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/SEED_DATA_MANIFEST.md');
  writeFileSync(file, lines.join('\n'));
  return { file, tables: Object.fromEntries(rows) };
}

// ---- main -----------------------------------------------------------------------------------------

export async function seed() {
  if (config.isProd) throw new Error('The development dataset must never be seeded in production');
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(config.db.host))) throw new Error(`DB_HOST ${config.db.host} is not local`);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (Number(n) > 0) throw new Error(`The database already has ${n} users. Run npm run db:backup:dev and npm run db:reset:dev first; the seed only builds into an empty organisation.`);
  const v = validate();
  console.log(`dataset valid: ${PEOPLE.length} people, ${PROJECTS.length} projects, ${MEETINGS.length + UPCOMING_MEETINGS.length} meetings, ${v.items} action items, ${JIRA_ISSUES.length} Jira issues, ${PULLS.length} pull requests`);
  if (!PASSWORD) console.log('SEED_USER_PASSWORD is not set: accounts are created without a password and cannot sign in until one is set.');

  const meetingUrls = Object.fromEntries([...MEETINGS, ...UPCOMING_MEETINGS].map((m) => [m.key, meetingUrl(m)]));
  const events = [];
  await withTransaction(async (conn) => {
    await seedOrganisation(conn);
    console.log('organisation: done');
    await seedJira(conn);
    await seedGithub(conn);
    await seedFigma(conn);
    await seedTeams(conn);
    await seedOutlook(conn, meetingUrls);
    console.log('integration history: done');
    await seedMeetings(conn, meetingUrls, events);
    await seedSourceItems(conn, events);
    const links = await seedLinks(conn);
    console.log(`meetings, transcripts, action items, ${links} links: done`);
    const n2 = await seedHistory(conn, events);
    console.log(`history: ${n2} dated events`);
  });
  const overdue = await notificationScan(NOW);
  console.log(`overdue notifications: ${JSON.stringify(overdue)}`);
  const plans = await seedApprovals();
  console.log(`approval plans: ${plans.length}`);
  await chronologicalNotifications();
  const m = await manifest();
  console.log(`manifest: ${m.file}`);
  return m;
}
