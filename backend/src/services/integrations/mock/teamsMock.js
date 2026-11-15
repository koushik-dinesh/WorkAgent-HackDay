// Microsoft Teams DEVELOPMENT MOCK: seeding, syncing, summary and reset
// (docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md).
//
// seed    the fictional organisation into WorkAgent's own tables: departments, people (no password:
//         they cannot sign in), WorkAgent teams with leads and members, projects with members.
//         Every row is registered in mock_records under a stable key, so a re-run updates instead
//         of duplicating, and names that collide with real data get a "(Violin Technologies)" suffix
//         instead of reusing the real row.
// sync    the mock connection's resources (Teams channels, meetings) through the normal sync engine
//         (ingest -> external records, activities, identities matched by e-mail), maps them to the
//         mock projects, then imports the meeting transcripts through the normal transcript importer
//         (WorkAgent meetings + transcripts; auto-extraction with WorkAPI when configured).
// reset   deletes exactly what the mock created: its connection, records, activities, links,
//         identities, imported meetings and the registered organisation rows. Never anything else.
import { config } from '../../../config/index.js';
import { pool } from '../../../db/pool.js';
import { withTransaction } from '../../../db/transaction.js';
import * as queue from '../../../jobs/queue.js';
import * as connectionsRepo from '../../../repositories/integrationConnectionsRepository.js';
import { AppError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { audit } from '../../audit.js';
import { ensureDerivedGroups } from '../../groups/index.js';
import { importRecord } from '../../transcripts/importer.js';
import { connectionService } from '../connections.js';
import { MOCK_ACCOUNT_ID, MOCK_SOURCE, anchorFor } from '../providers/microsoft/teamsMock.js';
import { registry as defaultRegistry } from '../registry.js';
import { syncEngine } from '../sync.js';
import { DEPARTMENTS, EMPLOYEES, MEETINGS, MOCK_ACCOUNT, ORGANISATION, PROJECTS, TEAMS } from './violinFixture.js';
import { TEAMS_SCOPES } from '../providers/microsoft/teams.js';

export const SOURCE = 'teams_mock';
const SUFFIX = ` (${ORGANISATION})`;

export const isMockMode = () => config.features.teamsMode === 'mock';
function assertNotProduction() {
  if (config.isProd) throw new AppError(409, 'MOCK_NOT_ALLOWED', 'Mock data is never used in production');
}

// ---- registry of mock rows ------------------------------------------------------------------------

async function registered(conn, naturalKey) {
  const [[r]] = await conn.query('SELECT entity_type, entity_id, metadata FROM mock_records WHERE source = ? AND natural_key = ?', [SOURCE, naturalKey]);
  return r ?? null;
}
async function register(conn, entityType, entityId, naturalKey, metadata = null) {
  await conn.execute(
    'INSERT INTO mock_records (source, entity_type, entity_id, natural_key, metadata) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE entity_id = VALUES(entity_id), metadata = VALUES(metadata)',
    [SOURCE, entityType, entityId, naturalKey, metadata ? JSON.stringify(metadata) : null],
  );
}
export async function mockIds(entityType, conn = pool) {
  const [rows] = await conn.query('SELECT entity_id FROM mock_records WHERE source = ? AND entity_type = ?', [SOURCE, entityType]);
  return rows.map((r) => r.entity_id);
}

/** The registered row id, or a new row from `create(name)` (name suffixed when a real row has it). */
async function upsertNamed(conn, { key, type, table, name, create, update }) {
  const reg = await registered(conn, key);
  if (reg) {
    const [[exists]] = await conn.query(`SELECT id FROM ${table} WHERE id = ?`, [reg.entity_id]);
    if (exists) {
      if (update) await update(reg.entity_id);
      return reg.entity_id;
    }
  }
  const [[clash]] = await conn.query(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  const id = await create(clash ? `${name}${SUFFIX}` : name);
  await register(conn, type, id, key, { name });
  return id;
}

// ---- seed -----------------------------------------------------------------------------------------

/** Seeds (or updates) the organisation. Returns counts and any skipped people. */
export async function seedOrganisation({ conn: outer = null } = {}) {
  assertNotProduction();
  const run = async (conn) => {
    const leaders = new Set([...TEAMS.map((t) => t.lead), ...PROJECTS.map((p) => p.lead), ...EMPLOYEES.filter((e) => EMPLOYEES.some((x) => x.managerId === e.id)).map((e) => e.id)]);
    const deptIds = {};
    for (const name of DEPARTMENTS) {
      deptIds[name] = await upsertNamed(conn, { key: `department:${name}`, type: 'department', table: 'departments', name, create: async (n) => (await conn.execute("INSERT INTO departments (name, source) VALUES (?, 'workagent')", [n]))[0].insertId });
    }
    const userIds = {};
    const skipped = [];
    for (const e of EMPLOYEES) {
      const key = `employee:${e.id}`;
      const reg = await registered(conn, key);
      const role = leaders.has(e.id) ? 'manager' : 'employee';
      let id = reg?.entity_id ?? null;
      const [[byEmail]] = await conn.query('SELECT id FROM users WHERE email = ?', [e.email]);
      if (id && !byEmail) id = null; // registered row was removed by hand
      if (!id && byEmail) {
        // An account with this address exists and is not ours: never adopt real data.
        skipped.push(e.email);
        continue;
      }
      if (id) {
        await conn.execute("UPDATE users SET full_name = ?, role = ?, department_id = ?, job_title = ?, directory_source = 'manual', is_active = TRUE WHERE id = ?", [e.name, role, deptIds[e.department], e.jobTitle, id]);
      } else {
        id = (await conn.execute("INSERT INTO users (email, full_name, role, password_hash, department_id, job_title, directory_source) VALUES (?, ?, ?, NULL, ?, ?, 'manual')", [e.email, e.name, role, deptIds[e.department], e.jobTitle]))[0].insertId;
      }
      await register(conn, 'user', id, key, { employeeId: e.id, managerId: e.managerId, department: e.department, jobTitle: e.jobTitle });
      userIds[e.id] = id;
    }
    const projectIds = {};
    for (const p of PROJECTS) {
      const owner = userIds[p.lead];
      projectIds[p.key] = await upsertNamed(conn, {
        key: `project:${p.key}`,
        type: 'project',
        table: 'projects',
        name: p.name,
        create: async (n) => (await conn.execute("INSERT INTO projects (name, description, status, owner_user_id) VALUES (?, ?, 'active', ?)", [n, `${p.description} (Development mock data)`, owner]))[0].insertId,
        update: (id) => conn.execute('UPDATE projects SET owner_user_id = ? WHERE id = ?', [owner, id]),
      });
    }
    const teamIds = {};
    for (const t of TEAMS) {
      const lead = userIds[t.lead];
      teamIds[t.key] = await upsertNamed(conn, {
        key: `team:${t.key}`,
        type: 'team',
        table: 'teams',
        name: t.name,
        create: async (n) => (await conn.execute('INSERT INTO teams (name, description, lead_user_id) VALUES (?, ?, ?)', [n, `${ORGANISATION} — development mock data`, lead]))[0].insertId,
        update: (id) => conn.execute('UPDATE teams SET lead_user_id = ? WHERE id = ?', [lead, id]),
      });
      for (const m of t.members) if (userIds[m]) await conn.execute('INSERT IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)', [teamIds[t.key], userIds[m]]);
      for (const m of [t.lead, ...t.members]) if (userIds[m]) await conn.execute('INSERT IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)', [projectIds[t.project], userIds[m]]);
    }
    await ensureDerivedGroups(conn);
    return { departments: DEPARTMENTS.length, employees: Object.keys(userIds).length, projects: PROJECTS.length, teams: TEAMS.length, skipped, userIds, projectIds, teamIds };
  };
  return outer ? run(outer) : withTransaction(run);
}

// ---- connection -----------------------------------------------------------------------------------

export async function findMockConnection(conn = pool) {
  const [[row]] = await conn.query("SELECT id FROM integration_connections WHERE provider = 'microsoft_teams' AND source_instance = ? ORDER BY id DESC LIMIT 1", [MOCK_SOURCE]);
  return row ? connectionsRepo.findById(row.id, { conn }) : null;
}

/** The mock connection, created (or reactivated) directly — used by the seed command and Sync. */
export async function ensureMockConnection(actorId = null) {
  let c = await findMockConnection();
  if (!c) {
    const id = await withTransaction(async (conn) => {
      const newId = await connectionsRepo.create(conn, { provider: 'microsoft_teams', sourceInstance: MOCK_SOURCE, externalAccountId: MOCK_ACCOUNT_ID, accountLogin: MOCK_ACCOUNT, accountType: 'user', displayName: `Microsoft Teams · Development mock (${ORGANISATION})`, status: 'active', connectedBy: actorId, settings: { mode: 'mock', mock: true, organisation: ORGANISATION, account: MOCK_ACCOUNT, anchor: anchorFor(), scopes: TEAMS_SCOPES, verified: false } });
      await connectionsRepo.update(conn, newId, { connectedAt: new Date(), isEnabled: true });
      await register(conn, 'connection', newId, 'connection:teams');
      return newId;
    });
    c = await connectionsRepo.findById(id);
  } else if (c.status !== 'active' || !c.isEnabled) {
    await withTransaction((conn) => connectionsRepo.update(conn, c.id, { status: 'active', isEnabled: true, connectedAt: new Date(), connectedBy: actorId ?? c.connectedBy, disconnectedAt: null, disconnectedBy: null }));
    c = await connectionsRepo.findById(c.id);
  }
  return c;
}

// ---- sync -----------------------------------------------------------------------------------------

async function syncToCompletion(resourceId) {
  for (let i = 0; i < 50; i++) {
    try {
      return await syncEngine.syncResource(resourceId);
    } catch (err) {
      if (!(err instanceof queue.RescheduleJob) || err.delayMs !== 0) throw err;
    }
  }
  throw new Error('mock sync did not finish');
}

/** Seeds the organisation and (re)imports all mock Teams data. Returns the summary. */
export async function syncMock({ actorId = null, registry = defaultRegistry } = {}) {
  assertNotProduction();
  if (!isMockMode()) throw new AppError(409, 'NOT_MOCK_MODE', 'Set TEAMS_INTEGRATION_MODE=mock to use the Microsoft Teams development mock');
  if (!registry.getAvailable('microsoft_teams')) throw new AppError(503, 'PROVIDER_UNAVAILABLE', registry.problem('microsoft_teams'));
  const org = await seedOrganisation();
  const connection = await ensureMockConnection(actorId);
  const resources = await connectionService.refreshResources(connection.id);
  // Channels belong to their team's project; meeting records get their own project below.
  for (const r of resources) {
    const projectKey = r.metadata?.project ?? null;
    await pool.execute('UPDATE integration_resources SET is_enabled = TRUE, project_id = ?, next_sync_at = NULL WHERE id = ?', [projectKey ? org.projectIds[projectKey] : null, r.id]);
  }
  for (const r of resources) await syncToCompletion(r.id);
  // Meeting records -> their fixture project (locked, so a resource re-mapping leaves them alone).
  const [meetingRecords] = await pool.query("SELECT id, external_id FROM external_records WHERE provider = 'microsoft_teams' AND source_instance = ? AND record_type = 'teams_meeting'", [MOCK_SOURCE]);
  for (const rec of meetingRecords) {
    const m = MEETINGS.find((x) => x.id === rec.external_id);
    if (m) await pool.execute('UPDATE external_records SET project_id = ?, project_locked = TRUE WHERE id = ?', [org.projectIds[m.project], rec.id]);
  }
  // Transcripts through the normal importer (creates WorkAgent meetings, queues extraction).
  const imported = {};
  for (const rec of meetingRecords) {
    try {
      imported[rec.external_id] = await importRecord(rec.id, { registry });
    } catch (err) {
      imported[rec.external_id] = `error: ${err.message}`;
    }
  }
  const [meetingRows] = await pool.query("SELECT i.meeting_id, r.external_id FROM meeting_transcript_imports i JOIN external_records r ON r.id = i.record_id WHERE r.source_instance = ? AND i.meeting_id IS NOT NULL", [MOCK_SOURCE]);
  await withTransaction(async (conn) => {
    for (const m of meetingRows) await register(conn, 'meeting', m.meeting_id, `meeting:${m.external_id}`);
  });
  await audit({ actorUserId: actorId, action: 'integration.mock_synced', entityType: 'integration_connection', entityId: connection.id, after: { mode: 'mock', employees: org.employees, skipped: org.skipped.length, imported } });
  logger.info('teams mock synced', { connectionId: connection.id, employees: org.employees });
  return { ...(await mockSummary()), skippedEmployees: org.skipped };
}

// ---- summary --------------------------------------------------------------------------------------

export async function mockSummary() {
  const c = await findMockConnection();
  const count = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);
  const base = [MOCK_SOURCE];
  const live = "provider = 'microsoft_teams' AND source_instance = ? AND source_deleted_at IS NULL";
  return {
    mode: config.features.teamsMode,
    connection: c ? { id: c.id, status: c.status, isEnabled: c.isEnabled, displayName: c.displayName, account: c.settings?.account ?? c.accountLogin, organisation: c.settings?.organisation ?? null, lastSyncSucceededAt: c.lastSyncSucceededAt, health: c.health } : null,
    counts: {
      teams: c ? await count("SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.teamId'))) AS n FROM integration_resources WHERE connection_id = ? AND resource_type = 'channel' AND access_status = 'accessible'", [c.id]) : 0,
      channels: c ? await count("SELECT COUNT(*) AS n FROM integration_resources WHERE connection_id = ? AND resource_type = 'channel' AND access_status = 'accessible'", [c.id]) : 0,
      meetings: await count(`SELECT COUNT(*) AS n FROM external_records WHERE ${live} AND record_type = 'teams_meeting'`, base),
      messages: await count(`SELECT COUNT(*) AS n FROM external_records WHERE ${live} AND record_type = 'message'`, base),
      replies: await count(`SELECT COUNT(*) AS n FROM external_records WHERE ${live} AND record_type = 'message' AND parent_record_id IS NOT NULL`, base),
      transcriptsImported: await count("SELECT COUNT(*) AS n FROM meeting_transcript_imports i JOIN external_records r ON r.id = i.record_id WHERE r.source_instance = ? AND i.status = 'imported'", base),
      employees: await count("SELECT COUNT(*) AS n FROM mock_records m JOIN users u ON u.id = m.entity_id WHERE m.source = ? AND m.entity_type = 'user'", [SOURCE]),
      departments: (await mockIds('department')).length,
      workagentTeams: (await mockIds('team')).length,
      projects: (await mockIds('project')).length,
    },
  };
}

/** Teams -> channels -> messages (with replies, reactions) and meetings, for "View Teams". */
export async function mockTeamsView() {
  const c = await findMockConnection();
  if (!c) return { connection: null, teams: [], meetings: [] };
  const [resources] = await pool.query("SELECT id, name, metadata, project_id FROM integration_resources WHERE connection_id = ? AND resource_type = 'channel' AND access_status = 'accessible' ORDER BY name", [c.id]);
  const [records] = await pool.query(
    `SELECT r.id, r.resource_id, r.parent_record_id, r.title, r.body, r.source_created_at, r.metadata, i.display_name AS author, i.user_id
     FROM external_records r LEFT JOIN external_identities i ON i.id = r.author_identity_id
     WHERE r.provider = 'microsoft_teams' AND r.source_instance = ? AND r.record_type = 'message' AND r.source_deleted_at IS NULL ORDER BY r.source_created_at`,
    [MOCK_SOURCE],
  );
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
  const msg = (r) => ({ id: r.id, author: r.author, userId: r.user_id, at: r.source_created_at, title: r.title, body: r.body, reactions: parse(r.metadata).reactions ?? [] });
  const teams = new Map();
  for (const res of resources) {
    const meta = parse(res.metadata);
    const t = teams.get(meta.teamId) ?? teams.set(meta.teamId, { id: meta.teamId, name: meta.team, projectId: res.project_id, channels: [] }).get(meta.teamId);
    const posts = records.filter((r) => r.resource_id === res.id && !r.parent_record_id);
    t.channels.push({ resourceId: res.id, name: meta.channel, messages: posts.map((p) => ({ ...msg(p), replies: records.filter((x) => x.parent_record_id === p.id).map(msg) })) });
  }
  const [meetings] = await pool.query(
    `SELECT r.id AS record_id, r.title, r.metadata, i.meeting_id, i.status AS import_status, m.status AS meeting_status, t.segment_count, p.name AS project
     FROM external_records r LEFT JOIN meeting_transcript_imports i ON i.record_id = r.id LEFT JOIN meetings m ON m.id = i.meeting_id
     LEFT JOIN transcripts t ON t.meeting_id = i.meeting_id LEFT JOIN projects p ON p.id = r.project_id
     WHERE r.provider = 'microsoft_teams' AND r.source_instance = ? AND r.record_type = 'teams_meeting' AND r.source_deleted_at IS NULL ORDER BY JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.start'))`,
    [MOCK_SOURCE],
  );
  return {
    connection: { id: c.id, displayName: c.displayName, status: c.status },
    teams: [...teams.values()],
    meetings: meetings.map((m) => {
      const meta = parse(m.metadata);
      return { recordId: m.record_id, title: m.title, start: meta.start, end: meta.end, team: meta.team ?? null, organizer: meta.organizer, attendees: meta.attendees?.length ?? 0, project: m.project, meetingId: m.meeting_id, importStatus: m.import_status, meetingStatus: m.meeting_status, transcriptSegments: m.segment_count ?? 0 };
    }),
  };
}

// ---- reset ----------------------------------------------------------------------------------------

/** Deletes only rows created by the mock (see header). Returns what was deleted or kept. */
export async function resetMock({ actorId = null } = {}) {
  assertNotProduction();
  const result = { connections: 0, records: 0, activities: 0, links: 0, identities: 0, meetings: 0, projects: 0, teams: 0, departments: 0, users: 0, keptUsers: [] };
  const [conns] = await pool.query("SELECT id FROM integration_connections WHERE provider = 'microsoft_teams' AND source_instance = ?", [MOCK_SOURCE]);
  const connIds = conns.map((c) => c.id);
  const [recRows] = await pool.query("SELECT id FROM external_records WHERE provider = 'microsoft_teams' AND source_instance = ?", [MOCK_SOURCE]);
  const recIds = recRows.map((r) => r.id);
  const [imp] = recIds.length ? await pool.query('SELECT meeting_id FROM meeting_transcript_imports WHERE record_id IN (?) AND meeting_id IS NOT NULL', [recIds]) : [[]];
  const meetingIds = [...new Set([...imp.map((r) => r.meeting_id), ...(await mockIds('meeting'))])];
  const [items] = meetingIds.length ? await pool.query('SELECT id FROM action_items WHERE meeting_id IN (?)', [meetingIds]) : [[]];
  const itemIds = items.map((i) => i.id);
  const projectIds = await mockIds('project');

  await withTransaction(async (conn) => {
    const del = async (sql, params) => (await conn.query(sql, params))[0].affectedRows;
    const endpoints = [['external_record', recIds], ['meeting', meetingIds], ['action_item', itemIds]].filter(([, ids]) => ids.length);
    for (const [type, ids] of endpoints) {
      result.links += await del('DELETE FROM record_links WHERE (from_type = ? AND from_id IN (?)) OR (to_type = ? AND to_id IN (?))', [type, ids, type, ids]);
      if (type !== 'meeting') {
        await del('DELETE FROM duplicate_candidates WHERE (a_type = ? AND a_id IN (?)) OR (b_type = ? AND b_id IN (?))', [type, ids, type, ids]);
        await del('DELETE FROM work_item_embeddings WHERE item_type = ? AND item_id IN (?)', [type, ids]);
      }
    }
    if (recIds.length) result.activities += await del('DELETE FROM activities WHERE external_record_id IN (?)', [recIds]);
    if (meetingIds.length) result.activities += await del("DELETE FROM activities WHERE entity_type = 'meeting' AND entity_id IN (?)", [meetingIds]);
    if (itemIds.length) result.activities += await del("DELETE FROM activities WHERE entity_type = 'action_item' AND entity_id IN (?)", [itemIds]);
    if (projectIds.length) result.activities += await del('DELETE FROM activities WHERE project_id IN (?)', [projectIds]);
    // Jobs about mock meetings that have not run yet (extraction, decisions).
    if (meetingIds.length) await del("DELETE FROM jobs WHERE status IN ('pending','failed','dead') AND type IN ('ai.extract','meeting.decisions_extract') AND JSON_EXTRACT(payload, '$.meetingId') IN (?)", [meetingIds]);
    if (meetingIds.length) result.meetings = await del('DELETE FROM meetings WHERE id IN (?)', [meetingIds]);
    if (recIds.length) {
      await del('UPDATE external_records SET parent_record_id = NULL WHERE id IN (?)', [recIds]);
      result.records = await del('DELETE FROM external_records WHERE id IN (?)', [recIds]);
    }
    result.identities = await del("DELETE FROM external_identities WHERE provider = 'microsoft_teams' AND source_instance = ?", [MOCK_SOURCE]);
    if (connIds.length) {
      await del('DELETE FROM integration_resources WHERE connection_id IN (?)', [connIds]);
      await del('UPDATE webhook_deliveries SET connection_id = NULL WHERE connection_id IN (?)', [connIds]);
      result.connections = await del('DELETE FROM integration_connections WHERE id IN (?)', [connIds]);
    }
    const teamIds = await mockIds('team', conn);
    if (teamIds.length) result.teams = await del('DELETE FROM teams WHERE id IN (?)', [teamIds]);
    if (projectIds.length) {
      await del('DELETE FROM integration_resources WHERE project_id IN (?)', [projectIds]).catch(() => 0);
      result.projects = await del('DELETE FROM projects WHERE id IN (?)', [projectIds]);
    }
    const deptIds = await mockIds('department', conn);
    if (deptIds.length) result.departments = await del('DELETE FROM departments WHERE id IN (?)', [deptIds]);
  });
  // People last, one by one: one referenced by real data (e.g. added to a real project) is kept
  // and deactivated instead, and reported.
  for (const userId of await mockIds('user')) {
    try {
      await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
      result.users += 1;
    } catch (err) {
      if (!String(err.code).startsWith('ER_ROW_IS_REFERENCED')) throw err;
      await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [userId]);
      result.keptUsers.push(userId);
      continue;
    }
  }
  await pool.query('DELETE FROM mock_records WHERE source = ? AND NOT (entity_type = ? AND entity_id IN (?))', [SOURCE, 'user', result.keptUsers.length ? result.keptUsers : [0]]);
  await audit({ actorUserId: actorId, action: 'integration.mock_reset', entityType: 'integration_connection', after: result });
  return result;
}
