// Groups for meeting invitations (Feature: department and group-based invitations).
//
// Four group types, all resolved to a member list at send time (never cached):
//   department  users whose department_id is the group's department (one group per department)
//   role        users whose job title equals role_value, or whose WorkAgent role is X for 'app:X'
//   project     the project's owner and members (one group per project)
//   custom      explicit members (user_group_members) plus nested groups (user_group_nesting),
//               expanded recursively with cycle detection. Directory groups (Entra ID, Google
//               Workspace) are custom groups with source entra/google, kept current by directory sync.
// Only active users are ever members. Every resolved member carries `via`: the groups that brought
// them in, so "who was invited and why" has an answer.
//
// Who may do what (enforced here, the UI only mirrors it):
//   see / search    admins and managers: every group; employees: their own department's group,
//                   project groups of visible projects, custom groups they own or belong to
//   invite          the same groups as "see"
//   create custom   everyone (owner = creator); edit/delete: owner or admin; directory groups: read-only
//   role groups     admins create and delete them
//   departments     admins create, rename and delete them and set people's department/job title
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { audit, recordAudit } from '../audit.js';
import { isAdmin, MANAGER_ROLES } from '../permissions.js';
import { visibleProjectIds } from '../records/access.js';

export const GROUP_TYPES = ['department', 'role', 'project', 'custom'];
export const APP_ROLE_PREFIX = 'app:';
const MAX_NESTING_DEPTH = 10;
const MAX_MEMBERS = 5000;

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export const toGroup = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description ?? null,
  type: r.group_type,
  source: r.source,
  externalId: r.external_id ?? null,
  departmentId: r.department_id ?? null,
  roleValue: r.role_value ?? null,
  projectId: r.project_id ?? null,
  ownerUserId: r.owner_user_id ?? null,
  isActive: Boolean(r.is_active),
  lastSyncedAt: r.last_synced_at ?? null,
  createdAt: r.created_at,
});

// ---- derived groups ------------------------------------------------------------------------------

/**
 * Makes sure every department and every non-archived project has its group (idempotent). Called
 * before listing, so a new department or project is invitable without a separate step.
 */
export async function ensureDerivedGroups(conn = pool) {
  await conn.query(
    `INSERT IGNORE INTO user_groups (name, group_type, source, external_id, department_id)
     SELECT d.name, 'department', d.source, NULL, d.id FROM departments d
     WHERE NOT EXISTS (SELECT 1 FROM user_groups g WHERE g.department_id = d.id)`,
  );
  await conn.query(
    `INSERT IGNORE INTO user_groups (name, group_type, project_id, owner_user_id)
     SELECT p.name, 'project', p.id, p.owner_user_id FROM projects p
     WHERE p.status <> 'archived' AND NOT EXISTS (SELECT 1 FROM user_groups g WHERE g.project_id = p.id)`,
  );
  // Names follow renames; archived projects' groups stop being offered.
  await conn.query(`UPDATE user_groups g JOIN departments d ON d.id = g.department_id SET g.name = d.name WHERE g.name <> d.name`);
  await conn.query(`UPDATE user_groups g JOIN projects p ON p.id = g.project_id SET g.name = p.name, g.is_active = (p.status <> 'archived') WHERE g.name <> p.name OR g.is_active <> (p.status <> 'archived')`);
}

// ---- visibility -----------------------------------------------------------------------------------

/** Everything visibility decisions need for one user, computed once. */
export async function groupScope(user, conn = pool) {
  const full = MANAGER_ROLES.includes(user.role);
  if (full) return { user, full: true };
  const projects = new Set((await visibleProjectIds(user, conn)) ?? []);
  const [[me]] = await conn.query('SELECT department_id FROM users WHERE id = ?', [user.id]);
  const [own] = await conn.query(
    `SELECT id FROM user_groups WHERE owner_user_id = ? UNION SELECT group_id FROM user_group_members WHERE user_id = ?`,
    [user.id, user.id],
  );
  return { user, full: false, projects, departmentId: me?.department_id ?? null, customIds: new Set(own.map((r) => r.id)) };
}

export function canSeeGroup(scope, g) {
  if (scope.full) return true;
  switch (g.type) {
    case 'department':
      return g.departmentId !== null && g.departmentId === scope.departmentId;
    case 'project':
      return scope.projects.has(g.projectId);
    case 'custom':
      return g.ownerUserId === scope.user.id || scope.customIds.has(g.id);
    default:
      return false; // role groups: admins and managers
  }
}

const canEditGroup = (user, g) => g.source === 'workagent' && (isAdmin(user) || (g.type === 'custom' && g.ownerUserId === user.id));

export async function findGroup(id, conn = pool) {
  const [[row]] = await conn.query('SELECT * FROM user_groups WHERE id = ?', [id]);
  return row ? toGroup(row) : null;
}

async function loadVisibleGroup(user, id, conn = pool) {
  const g = await findGroup(id, conn);
  if (!g || !canSeeGroup(await groupScope(user, conn), g)) throw notFound('Group not found');
  return g;
}

// ---- membership resolution ------------------------------------------------------------------------

/** Active direct members of one group (no nesting): [{ id, fullName, email }]. */
async function directMembers(g, conn) {
  let sql;
  let params;
  switch (g.type) {
    case 'department':
      sql = 'SELECT id, full_name, email FROM users WHERE is_active = TRUE AND department_id = ?';
      params = [g.departmentId];
      break;
    case 'role':
      if (g.roleValue?.startsWith(APP_ROLE_PREFIX)) {
        sql = 'SELECT id, full_name, email FROM users WHERE is_active = TRUE AND role = ?';
        params = [g.roleValue.slice(APP_ROLE_PREFIX.length)];
      } else {
        sql = 'SELECT id, full_name, email FROM users WHERE is_active = TRUE AND LOWER(job_title) = LOWER(?)';
        params = [g.roleValue ?? ''];
      }
      break;
    case 'project':
      sql = `SELECT u.id, u.full_name, u.email FROM users u
             WHERE u.is_active = TRUE AND (u.id = (SELECT owner_user_id FROM projects WHERE id = ?)
               OR u.id IN (SELECT user_id FROM project_members WHERE project_id = ?))`;
      params = [g.projectId, g.projectId];
      break;
    default:
      sql = `SELECT u.id, u.full_name, u.email FROM user_group_members m JOIN users u ON u.id = m.user_id
             WHERE m.group_id = ? AND u.is_active = TRUE`;
      params = [g.id];
  }
  const [rows] = await conn.query(`${sql} ORDER BY full_name LIMIT ${MAX_MEMBERS + 1}`, params);
  if (rows.length > MAX_MEMBERS) throw new AppError(422, 'GROUP_TOO_LARGE', `Group "${g.name}" has more than ${MAX_MEMBERS} members`);
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email }));
}

async function childIds(groupId, conn) {
  const [rows] = await conn.query('SELECT child_group_id FROM user_group_nesting WHERE parent_group_id = ?', [groupId]);
  return rows.map((r) => r.child_group_id);
}

/**
 * Members of a group with nested groups expanded. Cycles are cut (each group is expanded once per
 * resolution) and reported. Returns { members: Map(userId -> { id, fullName, email, via: Set(groupId) }),
 * cycles: [groupId], groups: Map(groupId -> group) }.
 */
export async function resolveGroup(group, conn = pool) {
  const members = new Map();
  const groups = new Map();
  const cycles = [];
  async function visit(g, path, depth) {
    if (path.includes(g.id)) {
      cycles.push(g.id);
      return;
    }
    if (depth > MAX_NESTING_DEPTH) throw new AppError(422, 'GROUP_NESTING_TOO_DEEP', `Groups are nested more than ${MAX_NESTING_DEPTH} levels`);
    groups.set(g.id, g);
    if (!g.isActive) return;
    for (const m of await directMembers(g, conn)) {
      const entry = members.get(m.id) ?? { ...m, via: new Set() };
      entry.via.add(group.id);
      members.set(m.id, entry);
    }
    if (g.type !== 'custom') return;
    for (const childId of await childIds(g.id, conn)) {
      const child = await findGroup(childId, conn);
      if (child) await visit(child, [...path, g.id], depth + 1);
    }
  }
  await visit(group, [], 0);
  return { members, groups, cycles };
}

/** Would adding child under parent create a cycle? (child reaches parent through nesting) */
async function wouldCycle(parentId, childId, conn) {
  const seen = new Set();
  const stack = [childId];
  while (stack.length) {
    const id = stack.pop();
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(await childIds(id, conn)));
  }
  return false;
}

// ---- reads ----------------------------------------------------------------------------------------

async function memberCounts(groups, conn) {
  const out = new Map();
  for (const g of groups) {
    try {
      out.set(g.id, (await resolveGroup(g, conn)).members.size);
    } catch {
      out.set(g.id, null);
    }
  }
  return out;
}

/** Groups the user can see, optionally filtered by type/text. Each with its live member count. */
export async function listGroups(user, { type, q, includeInactive = false } = {}) {
  await ensureDerivedGroups();
  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('is_active = TRUE');
  if (type) {
    where.push('group_type = ?');
    params.push(type);
  }
  if (q) {
    where.push('name LIKE ?');
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
  }
  const [rows] = await pool.query(`SELECT * FROM user_groups WHERE ${where.join(' AND ')} ORDER BY group_type, name LIMIT 500`, params);
  const scope = await groupScope(user);
  const groups = rows.map(toGroup).filter((g) => canSeeGroup(scope, g));
  const counts = await memberCounts(groups, pool);
  return groups.map((g) => ({ ...g, memberCount: counts.get(g.id), permissions: { canEdit: canEditGroup(user, g), canDelete: canEditGroup(user, g) && g.type !== 'project' && g.type !== 'department' } }));
}

/** One group with members (resolved, with `via`) and, for custom groups, its explicit members and nested groups. */
export async function getGroup(user, id) {
  const g = await loadVisibleGroup(user, id);
  const { members, cycles } = await resolveGroup(g);
  const [explicit] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.is_active, m.source, m.added_at FROM user_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.full_name`,
    [id],
  );
  const [nested] = await pool.query(
    `SELECT g.* FROM user_group_nesting n JOIN user_groups g ON g.id = n.child_group_id WHERE n.parent_group_id = ? ORDER BY g.name`,
    [id],
  );
  return {
    group: { ...g, memberCount: members.size, permissions: { canEdit: canEditGroup(user, g), canDelete: canEditGroup(user, g) && !['project', 'department'].includes(g.type) } },
    members: [...members.values()].map((m) => ({ id: m.id, fullName: m.fullName, email: m.email, via: [...m.via] })),
    explicitMembers: explicit.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, isActive: Boolean(r.is_active), source: r.source, addedAt: r.added_at })),
    nestedGroups: nested.map(toGroup),
    cycles,
    membershipSource: { department: 'People whose department is this department', role: 'People with this job title or WorkAgent role', project: 'The project owner and members', custom: g.source === 'workagent' ? 'Members added in WorkAgent and nested groups' : `Synced from ${g.source === 'entra' ? 'Microsoft Entra ID' : 'Google Workspace'}` }[g.type],
  };
}

// ---- writes ---------------------------------------------------------------------------------------

async function activeUserIds(ids, conn = pool) {
  if (!ids.length) return [];
  const [rows] = await conn.query('SELECT id FROM users WHERE id IN (?) AND is_active = TRUE', [ids]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length) throw badRequest('Unknown or inactive users', missing.map((m) => ({ field: 'userIds', message: `User ${m} is not active` })));
  return ids;
}

export async function createGroup(user, { name, description = null, type = 'custom', roleValue = null, memberIds = [], childGroupIds = [] }, ip) {
  if (type === 'department' || type === 'project') throw badRequest('Department and project groups are created with their department or project');
  if (type === 'role' && !isAdmin(user)) throw forbidden('Only admins create role groups');
  if (type === 'role' && !roleValue) throw badRequest('A role group needs a job title or WorkAgent role', [{ field: 'roleValue', message: 'Required' }]);
  if (type === 'role' && roleValue.startsWith(APP_ROLE_PREFIX) && !['admin', 'manager', 'employee'].includes(roleValue.slice(APP_ROLE_PREFIX.length))) {
    throw badRequest('Unknown WorkAgent role', [{ field: 'roleValue', message: 'Use app:admin, app:manager or app:employee' }]);
  }
  if (type === 'role' && (memberIds.length || childGroupIds.length)) throw badRequest('Role groups take their members from job titles; add no members');
  const ids = await activeUserIds([...new Set(memberIds)]);
  const id = await withTransaction(async (conn) => {
    let groupId;
    try {
      const [r] = await conn.execute(
        'INSERT INTO user_groups (name, description, group_type, role_value, owner_user_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [name, description, type, type === 'role' ? roleValue : null, type === 'custom' ? user.id : null, user.id],
      );
      groupId = r.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('A role group for this role already exists');
      throw err;
    }
    if (ids.length) await conn.query('INSERT INTO user_group_members (group_id, user_id, source, added_by) VALUES ?', [ids.map((u) => [groupId, u, 'manual', user.id])]);
    for (const childId of [...new Set(childGroupIds)]) await addChild(conn, user, groupId, childId);
    await recordAudit(conn, { actorUserId: user.id, action: 'group.created', entityType: 'group', entityId: groupId, after: { name, type, roleValue, members: ids.length, nested: childGroupIds.length }, ip });
    return groupId;
  });
  return getGroup(user, id);
}

async function loadEditable(conn, user, id) {
  const [[row]] = await conn.query('SELECT * FROM user_groups WHERE id = ? FOR UPDATE', [id]);
  const g = row ? toGroup(row) : null;
  if (!g || !canSeeGroup(await groupScope(user, conn), g)) throw notFound('Group not found');
  if (g.source !== 'workagent') throw new AppError(409, 'DIRECTORY_GROUP', `This group is managed by ${g.source === 'entra' ? 'Microsoft Entra ID' : 'Google Workspace'}; change it there`);
  if (!canEditGroup(user, g)) throw forbidden('Only the group owner or an admin can change this group');
  return g;
}

async function addChild(conn, user, parentId, childId) {
  if (parentId === childId) throw badRequest('A group cannot contain itself');
  const child = await findGroup(childId, conn);
  if (!child || !canSeeGroup(await groupScope(user, conn), child)) throw badRequest('Unknown group', [{ field: 'childGroupIds', message: `Group ${childId} not found` }]);
  if (await wouldCycle(parentId, childId, conn)) throw new AppError(409, 'GROUP_CYCLE', `Adding "${child.name}" would make the groups contain each other`);
  await conn.execute('INSERT IGNORE INTO user_group_nesting (parent_group_id, child_group_id, added_by) VALUES (?, ?, ?)', [parentId, childId, user.id]);
}

export async function updateGroup(user, id, { name, description }, ip) {
  await withTransaction(async (conn) => {
    const g = await loadEditable(conn, user, id);
    if (g.type === 'department' || g.type === 'project') throw badRequest('Rename the department or project instead');
    await conn.execute('UPDATE user_groups SET name = COALESCE(?, name), description = ? WHERE id = ?', [name ?? null, description === undefined ? g.description : description, id]);
    await recordAudit(conn, { actorUserId: user.id, action: 'group.updated', entityType: 'group', entityId: id, before: { name: g.name, description: g.description }, after: { name: name ?? g.name, description: description === undefined ? g.description : description }, ip });
  });
  return getGroup(user, id);
}

export async function deleteGroup(user, id, ip) {
  await withTransaction(async (conn) => {
    const g = await loadEditable(conn, user, id);
    if (g.type === 'department' || g.type === 'project') throw badRequest('Department and project groups go away with their department or project');
    await conn.execute('DELETE FROM user_groups WHERE id = ?', [id]);
    await recordAudit(conn, { actorUserId: user.id, action: 'group.deleted', entityType: 'group', entityId: id, before: { name: g.name, type: g.type }, ip });
  });
}

/**
 * Adds members. Custom groups: explicit members and nested groups. Department and role groups
 * (admins): sets the person's department or job title, so the change is the directory attribute.
 */
export async function addMembers(user, id, { userIds = [], childGroupIds = [] }, ip) {
  await withTransaction(async (conn) => {
    const g = await loadEditable(conn, user, id);
    const ids = await activeUserIds([...new Set(userIds)], conn);
    if (g.type === 'project') throw badRequest('Project team members are managed on the project page');
    if (g.type === 'department') {
      if (childGroupIds.length) throw badRequest('Only custom groups contain other groups');
      if (ids.length) await conn.query("UPDATE users SET department_id = ?, directory_source = 'manual' WHERE id IN (?)", [g.departmentId, ids]);
    } else if (g.type === 'role') {
      if (childGroupIds.length) throw badRequest('Only custom groups contain other groups');
      if (g.roleValue.startsWith(APP_ROLE_PREFIX)) throw badRequest('WorkAgent roles are changed on the Users page');
      if (ids.length) await conn.query("UPDATE users SET job_title = ?, directory_source = 'manual' WHERE id IN (?)", [g.roleValue, ids]);
    } else {
      if (ids.length) await conn.query('INSERT IGNORE INTO user_group_members (group_id, user_id, source, added_by) VALUES ?', [ids.map((u) => [id, u, 'manual', user.id])]);
      for (const childId of [...new Set(childGroupIds)]) await addChild(conn, user, id, childId);
    }
    await recordAudit(conn, { actorUserId: user.id, action: 'group.members_added', entityType: 'group', entityId: id, after: { userIds: ids, childGroupIds }, ip });
  });
  return getGroup(user, id);
}

export async function removeMember(user, id, { userId = null, childGroupId = null }, ip) {
  await withTransaction(async (conn) => {
    const g = await loadEditable(conn, user, id);
    if (g.type === 'project') throw badRequest('Project team members are managed on the project page');
    if (userId) {
      if (g.type === 'department') await conn.execute("UPDATE users SET department_id = NULL, directory_source = 'manual' WHERE id = ? AND department_id = ?", [userId, g.departmentId]);
      else if (g.type === 'role') {
        if (g.roleValue.startsWith(APP_ROLE_PREFIX)) throw badRequest('WorkAgent roles are changed on the Users page');
        await conn.execute("UPDATE users SET job_title = NULL, directory_source = 'manual' WHERE id = ? AND LOWER(job_title) = LOWER(?)", [userId, g.roleValue]);
      } else await conn.execute('DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?', [id, userId]);
    }
    if (childGroupId) await conn.execute('DELETE FROM user_group_nesting WHERE parent_group_id = ? AND child_group_id = ?', [id, childGroupId]);
    await recordAudit(conn, { actorUserId: user.id, action: 'group.member_removed', entityType: 'group', entityId: id, before: { userId, childGroupId }, ip });
  });
  return getGroup(user, id);
}

// ---- departments ----------------------------------------------------------------------------------

export async function listDepartments() {
  const [rows] = await pool.query(
    `SELECT d.id, d.name, d.source, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = TRUE) AS members
     FROM departments d ORDER BY d.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, source: r.source, memberCount: Number(r.members) }));
}

export async function createDepartment(user, name, ip) {
  try {
    const [r] = await pool.execute('INSERT INTO departments (name, created_by) VALUES (?, ?)', [name, user.id]);
    await ensureDerivedGroups();
    await audit({ actorUserId: user.id, action: 'department.created', entityType: 'department', entityId: r.insertId, after: { name }, ip });
    return (await listDepartments()).find((d) => d.id === r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('A department with this name already exists');
    throw err;
  }
}

export async function renameDepartment(user, id, name, ip) {
  const [[d]] = await pool.query('SELECT * FROM departments WHERE id = ?', [id]);
  if (!d) throw notFound('Department not found');
  if (d.source !== 'workagent') throw new AppError(409, 'DIRECTORY_DEPARTMENT', 'This department is synced from the directory; rename it there');
  try {
    await pool.execute('UPDATE departments SET name = ? WHERE id = ?', [name, id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('A department with this name already exists');
    throw err;
  }
  await ensureDerivedGroups();
  await audit({ actorUserId: user.id, action: 'department.renamed', entityType: 'department', entityId: id, before: { name: d.name }, after: { name }, ip });
  return (await listDepartments()).find((x) => x.id === id);
}

export async function deleteDepartment(user, id, ip) {
  const [[d]] = await pool.query('SELECT * FROM departments WHERE id = ?', [id]);
  if (!d) throw notFound('Department not found');
  // People keep their accounts; their department becomes empty (FK ON DELETE SET NULL).
  await pool.execute('DELETE FROM departments WHERE id = ?', [id]);
  await audit({ actorUserId: user.id, action: 'department.deleted', entityType: 'department', entityId: id, before: { name: d.name }, ip });
}

export { parse as parseJson };
