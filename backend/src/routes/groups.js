import { Router } from 'express';
import { z } from 'zod';
import * as queue from '../jobs/queue.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { pool } from '../db/pool.js';
import { audit } from '../services/audit.js';
import * as groups from '../services/groups/index.js';
import { JOB_TYPE as DIRECTORY_JOB, directoryStatus } from '../services/groups/directorySync.js';
import { conflict, notFound } from '../utils/errors.js';
import { id, idParams } from '../utils/validation.js';

const name = z.string().trim().min(1, 'Required').max(200);
const ids = z.array(id).max(1000);
const createSchema = z
  .object({
    name,
    description: z.string().trim().max(1000).nullable().optional(),
    type: z.enum(['custom', 'role']).default('custom'),
    // Role groups: a job title, or app:admin / app:manager / app:employee.
    roleValue: z.string().trim().min(1).max(200).nullable().optional(),
    memberIds: ids.default([]),
    childGroupIds: ids.default([]),
  })
  .strict();
const updateSchema = z.object({ name: name.optional(), description: z.string().trim().max(1000).nullable().optional() }).strict();
const membersSchema = z.object({ userIds: ids.default([]), childGroupIds: ids.default([]) }).strict().refine((v) => v.userIds.length || v.childGroupIds.length, 'Add at least one person or group');
const listQuery = z.object({ type: z.enum(groups.GROUP_TYPES).optional(), q: z.string().trim().max(100).optional(), includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }).strict();

// Mounted at /groups behind requireAuth. Permissions per group in services/groups.
export const groupsRouter = Router();

// Directory sync (admins). Before /:id so the paths don't collide.
groupsRouter.get('/directory/status', requireRole('admin'), async (req, res) => res.json(await directoryStatus()));
groupsRouter.post('/directory/sync', requireRole('admin'), validate({ body: z.object({ connectionId: id }).strict() }), async (req, res) => {
  const status = await directoryStatus();
  const c = status.connections.find((x) => x.connectionId === req.body.connectionId);
  if (!c) throw notFound('Connection not found');
  if (!c.canSync) throw conflict(c.problem ?? 'This connection cannot read the directory');
  let jobId;
  try {
    jobId = await queue.enqueue(DIRECTORY_JOB, { connectionId: c.connectionId, actorId: req.user.id }, { dedupeKey: `${DIRECTORY_JOB}:${c.connectionId}` });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('A directory sync for this connection is already queued');
    throw err;
  }
  await audit({ actorUserId: req.user.id, action: 'directory.sync_requested', entityType: 'directory', after: { connectionId: c.connectionId }, ip: req.ip });
  res.status(202).json({ jobId });
});

groupsRouter.get('/', validate({ query: listQuery }), async (req, res) => res.json({ groups: await groups.listGroups(req.user, req.query) }));
groupsRouter.post('/', validate({ body: createSchema }), async (req, res) => res.status(201).json(await groups.createGroup(req.user, req.body, req.ip)));
groupsRouter.get('/:id', validate({ params: idParams }), async (req, res) => res.json(await groups.getGroup(req.user, req.params.id)));
groupsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), async (req, res) => res.json(await groups.updateGroup(req.user, req.params.id, req.body, req.ip)));
groupsRouter.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await groups.deleteGroup(req.user, req.params.id, req.ip);
  res.status(204).end();
});
groupsRouter.post('/:id/members', validate({ params: idParams, body: membersSchema }), async (req, res) => res.json(await groups.addMembers(req.user, req.params.id, req.body, req.ip)));
groupsRouter.delete('/:id/members/:userId', validate({ params: z.object({ id, userId: id }) }), async (req, res) => res.json(await groups.removeMember(req.user, req.params.id, { userId: req.params.userId }, req.ip)));
groupsRouter.delete('/:id/groups/:childId', validate({ params: z.object({ id, childId: id }) }), async (req, res) => res.json(await groups.removeMember(req.user, req.params.id, { childGroupId: req.params.childId }, req.ip)));

// Mounted at /departments behind requireAuth: everyone reads; admins change.
export const departmentsRouter = Router();
departmentsRouter.get('/', async (req, res) => res.json({ departments: await groups.listDepartments() }));
departmentsRouter.post('/', requireRole('admin'), validate({ body: z.object({ name }).strict() }), async (req, res) => res.status(201).json({ department: await groups.createDepartment(req.user, req.body.name, req.ip) }));
departmentsRouter.patch('/:id', requireRole('admin'), validate({ params: idParams, body: z.object({ name }).strict() }), async (req, res) => res.json({ department: await groups.renameDepartment(req.user, req.params.id, req.body.name, req.ip) }));
departmentsRouter.delete('/:id', requireRole('admin'), validate({ params: idParams }), async (req, res) => {
  await groups.deleteDepartment(req.user, req.params.id, req.ip);
  res.status(204).end();
});

/** People search for pickers (active colleagues; names and e-mail, as in any address book). */
export async function searchPeople(q, limit = 20) {
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.job_title, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = TRUE AND (u.full_name LIKE ? OR u.email LIKE ?) ORDER BY u.full_name LIMIT ?`,
    [like, like, limit],
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, jobTitle: r.job_title, department: r.department }));
}
