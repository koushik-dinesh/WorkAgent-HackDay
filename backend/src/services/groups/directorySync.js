// Directory synchronisation for groups (optional; WorkAgent works without it).
//
// Sources, through connections an admin already made, only when their grant includes the optional
// directory scopes (MS_DIRECTORY_SYNC / GOOGLE_DIRECTORY_SYNC, then reconnect):
//   Microsoft Entra ID   Graph /users (department, jobTitle), /groups and /groups/{id}/members
//   Google Workspace     Admin SDK users (organizations[].department/title), groups and members
//
// What it changes:
//   - departments named in the directory are created (source entra/google); their groups follow
//   - WorkAgent users are matched by e-mail only (nobody is created); their department and job title
//     come from the directory unless an admin set them by hand (directory_source = 'manual')
//   - directory groups become custom groups (source entra/google, read-only in WorkAgent) with
//     directory members and nested groups; groups gone from the directory are deactivated
// Runs daily from the worker and on demand (admin). Never throws for a missing configuration:
// it reports what is missing instead.
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as connectionsRepo from '../../repositories/integrationConnectionsRepository.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit.js';
import { buildContext } from '../integrations/context.js';
import { canReadGoogleDirectory, directoryApi } from '../integrations/providers/google/calendar.js';
import { graphClient, listAll } from '../integrations/providers/microsoft/graph.js';
import { canReadDirectory } from '../integrations/providers/microsoft/outlook.js';
import { registry as defaultRegistry } from '../integrations/registry.js';
import { ensureDerivedGroups } from './index.js';

export const JOB_TYPE = 'directory.sync';
const SOURCES = { outlook: 'entra', google_calendar: 'google' };
const MAX_GROUPS = 2000;

const settingKey = (connectionId) => `directory_sync:${connectionId}`;
const canRead = (c) => (c.provider === 'outlook' ? canReadDirectory(c) : c.provider === 'google_calendar' ? canReadGoogleDirectory(c) : false);

/** Connections that could sync the directory, with their status and last result. */
export async function directoryStatus({ registry = defaultRegistry } = {}) {
  const [rows] = await pool.query("SELECT id FROM integration_connections WHERE provider IN ('outlook','google_calendar') AND status = 'active' ORDER BY id");
  const out = [];
  for (const r of rows) {
    const c = await connectionsRepo.findById(r.id);
    const [[last]] = await pool.query('SELECT value FROM app_settings WHERE setting_key = ?', [settingKey(c.id)]);
    out.push({
      connectionId: c.id,
      provider: c.provider,
      source: SOURCES[c.provider],
      displayName: c.displayName,
      canSync: canRead(c) && Boolean(registry.getAvailable(c.provider)),
      problem: !registry.getAvailable(c.provider)
        ? registry.problem(c.provider)
        : !canRead(c)
          ? c.provider === 'outlook'
            ? 'Set MS_DIRECTORY_SYNC=true, reconnect Outlook and grant admin consent for User.Read.All and GroupMember.Read.All'
            : 'Set GOOGLE_DIRECTORY_SYNC=true and reconnect Google with a Workspace admin account'
          : null,
      lastRun: last ? (typeof last.value === 'string' ? JSON.parse(last.value) : last.value) : null,
    });
  }
  return { connections: out, configured: out.some((c) => c.canSync) };
}

// ---- fetching -------------------------------------------------------------------------------------

async function fetchEntra(ctx) {
  const api = graphClient(ctx);
  const users = await listAll(api, '/v1.0/users', { $select: 'id,displayName,mail,userPrincipalName,department,jobTitle,accountEnabled' });
  const groups = (await listAll(api, '/v1.0/groups', { $select: 'id,displayName,description,mail' })).slice(0, MAX_GROUPS);
  const members = new Map();
  for (const g of groups) {
    const list = await listAll(api, `/v1.0/groups/${encodeURIComponent(g.id)}/members`, { $select: 'id,mail,userPrincipalName' });
    members.set(g.id, list.map((m) => (String(m['@odata.type'] ?? '').endsWith('.group') ? { type: 'group', id: m.id } : { type: 'user', email: String(m.mail ?? m.userPrincipalName ?? '').toLowerCase() })));
  }
  return {
    users: users.filter((u) => u.accountEnabled !== false).map((u) => ({ email: String(u.mail ?? u.userPrincipalName ?? '').toLowerCase(), department: u.department?.trim() || null, jobTitle: u.jobTitle?.trim() || null })),
    groups: groups.map((g) => ({ id: g.id, name: g.displayName ?? g.mail ?? g.id, description: g.description ?? null })),
    members,
  };
}

async function pagesOf(api, path, key, query = {}) {
  const out = [];
  let pageToken;
  for (let i = 0; i < 50; i++) {
    const res = await api.get(path, { query: { ...query, pageToken } });
    out.push(...(res.body?.[key] ?? []));
    pageToken = res.body?.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function fetchGoogle(ctx) {
  const api = directoryApi(ctx);
  const users = await pagesOf(api, '/admin/directory/v1/users', 'users', { customer: 'my_customer', maxResults: 500, projection: 'full' });
  const groups = (await pagesOf(api, '/admin/directory/v1/groups', 'groups', { customer: 'my_customer', maxResults: 200 })).slice(0, MAX_GROUPS);
  const members = new Map();
  for (const g of groups) {
    const list = await pagesOf(api, `/admin/directory/v1/groups/${encodeURIComponent(g.id)}/members`, 'members', { maxResults: 200 });
    members.set(g.id, list.map((m) => (m.type === 'GROUP' ? { type: 'group', id: m.id } : { type: 'user', email: String(m.email ?? '').toLowerCase() })));
  }
  return {
    users: users.filter((u) => !u.suspended).map((u) => {
      const org = (u.organizations ?? []).find((o) => o.primary) ?? u.organizations?.[0] ?? {};
      return { email: String(u.primaryEmail ?? '').toLowerCase(), department: org.department?.trim() || null, jobTitle: org.title?.trim() || null };
    }),
    groups: groups.map((g) => ({ id: g.id, name: g.name ?? g.email ?? g.id, description: g.description ?? null })),
    members,
  };
}

// ---- applying -------------------------------------------------------------------------------------

/** Writes a fetched directory snapshot. Returns counts. */
export async function applySnapshot(source, snap, { actorId = null } = {}) {
  return withTransaction(async (conn) => {
    const [userRows] = await conn.query('SELECT id, LOWER(email) AS email, directory_source FROM users');
    const byEmail = new Map(userRows.map((u) => [u.email, u]));
    const counts = { usersMatched: 0, usersUpdated: 0, departments: 0, groups: 0, groupsDeactivated: 0, memberships: 0, unmatchedMembers: 0 };

    // Departments
    const deptIds = new Map();
    for (const name of new Set(snap.users.map((u) => u.department).filter(Boolean))) {
      const ext = name.toLowerCase().slice(0, 191);
      await conn.execute('INSERT INTO departments (name, source, external_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE external_id = COALESCE(external_id, VALUES(external_id))', [name.slice(0, 200), source, ext]);
      const [[d]] = await conn.query('SELECT id FROM departments WHERE name = ?', [name.slice(0, 200)]);
      deptIds.set(name, d.id);
      counts.departments += 1;
    }
    // People (matched by e-mail; manual attributes win)
    for (const u of snap.users) {
      const row = byEmail.get(u.email);
      if (!row) continue;
      counts.usersMatched += 1;
      if (row.directory_source === 'manual') {
        const [[cur]] = await conn.query('SELECT department_id, job_title FROM users WHERE id = ?', [row.id]);
        if (cur.department_id !== null || cur.job_title !== null) continue;
      }
      const [r] = await conn.execute('UPDATE users SET department_id = ?, job_title = ?, directory_source = ? WHERE id = ?', [u.department ? deptIds.get(u.department) : null, u.jobTitle?.slice(0, 200) ?? null, source, row.id]);
      counts.usersUpdated += r.changedRows;
    }
    // Groups
    const groupIds = new Map();
    for (const g of snap.groups) {
      await conn.execute(
        `INSERT INTO user_groups (name, description, group_type, source, external_id, is_active, last_synced_at) VALUES (?, ?, 'custom', ?, ?, TRUE, NOW())
         ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), is_active = TRUE, last_synced_at = NOW()`,
        [String(g.name).slice(0, 200), g.description?.slice(0, 1000) ?? null, source, String(g.id).slice(0, 191)],
      );
      const [[row]] = await conn.query('SELECT id FROM user_groups WHERE source = ? AND external_id = ?', [source, String(g.id).slice(0, 191)]);
      groupIds.set(g.id, row.id);
      counts.groups += 1;
    }
    const [gone] = await conn.query(`UPDATE user_groups SET is_active = FALSE WHERE source = ? AND group_type = 'custom' AND is_active = TRUE${groupIds.size ? ' AND id NOT IN (?)' : ''}`, groupIds.size ? [source, [...groupIds.values()]] : [source]);
    counts.groupsDeactivated = gone.affectedRows;
    // Members and nesting (replace the directory's rows)
    for (const [extId, list] of snap.members) {
      const gid = groupIds.get(extId);
      if (!gid) continue;
      await conn.execute("DELETE FROM user_group_members WHERE group_id = ? AND source = 'directory'", [gid]);
      await conn.execute('DELETE FROM user_group_nesting WHERE parent_group_id = ?', [gid]);
      const userIds = [...new Set(list.filter((m) => m.type === 'user').map((m) => byEmail.get(m.email)?.id).filter(Boolean))];
      counts.unmatchedMembers += list.filter((m) => m.type === 'user' && !byEmail.get(m.email)).length;
      if (userIds.length) await conn.query("INSERT IGNORE INTO user_group_members (group_id, user_id, source) VALUES ?", [userIds.map((u) => [gid, u, 'directory'])]);
      counts.memberships += userIds.length;
      for (const child of list.filter((m) => m.type === 'group')) {
        const cid = groupIds.get(child.id);
        // A directory with a membership cycle: keep the first edge, skip the closing one.
        if (cid && cid !== gid) await conn.execute('INSERT IGNORE INTO user_group_nesting (parent_group_id, child_group_id) VALUES (?, ?)', [gid, cid]);
      }
    }
    await ensureDerivedGroups(conn);
    await recordAudit(conn, { actorUserId: actorId, action: 'directory.synced', entityType: 'directory', entityId: null, after: { source, ...counts } });
    return counts;
  });
}

/** Syncs one connection's directory. Returns { ok, counts? , problem? }. */
export async function syncDirectory(connectionId, { actorId = null, registry = defaultRegistry } = {}) {
  const c = await connectionsRepo.findById(connectionId);
  const finish = async (result) => {
    await pool.execute('INSERT INTO app_settings (setting_key, value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)', [settingKey(connectionId), JSON.stringify({ at: new Date().toISOString(), ...result }), actorId]);
    return result;
  };
  if (!c || !SOURCES[c.provider] || c.status !== 'active') return finish({ ok: false, problem: 'Connection not available' });
  const connector = registry.getAvailable(c.provider);
  if (!connector) return finish({ ok: false, problem: registry.problem(c.provider) });
  if (!canRead(c)) return finish({ ok: false, problem: 'The connection was not granted directory access' });
  try {
    const ctx = buildContext(connector, c);
    const snap = c.provider === 'outlook' ? await fetchEntra(ctx) : await fetchGoogle(ctx);
    const counts = await applySnapshot(SOURCES[c.provider], snap, { actorId });
    logger.info('directory synced', { connectionId, source: SOURCES[c.provider], ...counts });
    return finish({ ok: true, counts });
  } catch (err) {
    logger.warn('directory sync failed', { connectionId, error: err.message });
    if (err.kind === 'transient' || err.kind === 'rate_limited') throw err; // retried by the job queue
    return finish({ ok: false, problem: err.publicMessage ?? err.message });
  }
}

/** Worker tick (daily): one job per connection that can read the directory. */
export async function enqueueDue(queue) {
  const { connections } = await directoryStatus();
  let n = 0;
  for (const c of connections.filter((x) => x.canSync)) {
    const last = c.lastRun?.at ? new Date(c.lastRun.at).getTime() : 0;
    if (Date.now() - last < 23 * 3_600_000) continue;
    try {
      await queue.enqueue(JOB_TYPE, { connectionId: c.connectionId }, { dedupeKey: `${JOB_TYPE}:${c.connectionId}` });
      n += 1;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  return n;
}
