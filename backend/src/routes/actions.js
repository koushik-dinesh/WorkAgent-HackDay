// Action Center and execution engine API (docs/ACTION_INTELLIGENCE.md). Every signed-in person;
// what each person may see, review, prepare and approve is decided in the services.
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireRole } from '../middleware/auth.js';
import { FLAGS } from '../services/ai/validator.js';
import { PRIORITIES } from '../services/ai/schema.js';
import * as center from '../services/actions/center.js';
import * as followups from '../services/actions/followups.js';
import { CATEGORIES } from '../services/actions/intelligence.js';
import * as sources from '../services/actions/sourceExtraction.js';
import * as engine from '../services/execution/index.js';
import { isValidIsoDate } from '../utils/dates.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const ids = z.array(id).max(500);
const listQuery = z
  .object({
    view: z.enum(center.VIEWS).default('all'),
    projectId: id.optional(),
    teamId: id.optional(),
    ownerId: id.optional(),
    meetingId: id.optional(),
    priority: z.enum(PRIORITIES).optional(),
    source: z.enum(center.SOURCE_TYPES).optional(),
    category: z.enum(CATEGORIES).optional(),
    reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
    taskStatus: z.enum(['todo', 'in_progress', 'blocked', 'done']).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const editSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    description: optionalNullable(z.string().trim().max(5000)),
    priority: z.enum(PRIORITIES),
    assigneeUserId: optionalNullable(id),
    dueDate: optionalNullable(z.string().refine(isValidIsoDate, 'Use a valid date (YYYY-MM-DD)')),
    category: z.enum(CATEGORIES),
    resolveFlags: z.array(z.enum(Object.keys(FLAGS))).max(30),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const prepareSchema = z
  .object({
    kind: z.enum(Object.keys(engine.KINDS)),
    actionItemIds: ids.default([]),
    options: z.record(z.string().max(40), z.unknown()).default({}),
  })
  .strict();
const approveSchema = z.object({ previewHash: z.string().regex(/^[0-9a-f]{64}$/), largeConfirmed: z.boolean().default(false) }).strict();
const reasonSchema = z.object({ reason: optionalNullable(z.string().trim().max(500)) }).strict();
const plansQuery = z.object({ status: z.string().regex(/^[a-z_,]{3,120}$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

const followupSchema = z
  .object({
    enabled: z.boolean(),
    reminderDaysBefore: z.number().int().min(0).max(14),
    overdueEscalationDays: z.number().int().min(0).max(30),
    noProgressDays: z.number().int().min(1).max(60),
    blockerEscalationDays: z.number().int().min(0).max(30),
    channels: z.object({ inApp: z.boolean(), email: z.boolean() }).partial().strict(),
  })
  .partial()
  .strict();
const sourceSettingsSchema = z
  .object({ enabled: z.boolean(), lookbackDays: z.number().int().min(1).max(90), maxThreadsPerRun: z.number().int().min(1).max(100), providers: z.record(z.enum(sources.SOURCES.map((s) => s.provider)), z.boolean()) })
  .partial()
  .strict();

const prepareLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (req) => `actions:prepare:${req.user.id}` });
const adminOnly = requireRole('admin');

// Mounted at /actions behind requireAuth.
export const actionsRouter = Router();

actionsRouter.get('/summary', async (req, res) => res.json(await center.summary(req.user)));
actionsRouter.get('/', validate({ query: listQuery }), async (req, res) => res.json(await center.list(req.user, req.query)));

// Organisation settings (admins).
actionsRouter.get('/settings', adminOnly, async (req, res) => res.json({ followups: await followups.getSettings(), sources: await sources.status() }));
actionsRouter.put('/settings/followups', adminOnly, validate({ body: followupSchema }), async (req, res) => res.json({ followups: await followups.updateSettings(req.user, req.body, { ip: req.ip }) }));
actionsRouter.put('/settings/sources', adminOnly, validate({ body: sourceSettingsSchema }), async (req, res) => res.json({ sources: await sources.updateSettings(req.user, req.body) }));
actionsRouter.post('/settings/sources/scan', adminOnly, async (req, res) => res.json({ result: await sources.scan() }));

// Execution engine.
actionsRouter.get('/execution/capabilities', async (req, res) => res.json(await engine.capabilities(req.user)));
actionsRouter.post('/execution/plans', prepareLimiter, validate({ body: prepareSchema }), async (req, res) => res.status(201).json(await engine.prepare(req.user, req.body)));
actionsRouter.get('/execution/plans', validate({ query: plansQuery }), async (req, res) => res.json({ plans: await engine.listPlans(req.user, req.query) }));
actionsRouter.get('/execution/plans/:id', validate({ params: idParams }), async (req, res) => res.json(await engine.getPlan(req.user, Number(req.params.id))));
actionsRouter.post('/execution/plans/:id/approve', validate({ params: idParams, body: approveSchema }), async (req, res) => res.json(await engine.approve(req.user, Number(req.params.id), req.body, { ip: req.ip })));
actionsRouter.post('/execution/plans/:id/cancel', validate({ params: idParams }), async (req, res) => res.json(await engine.cancel(req.user, Number(req.params.id), { ip: req.ip })));
actionsRouter.post('/execution/plans/:id/reject', validate({ params: idParams, body: reasonSchema }), async (req, res) => res.json(await engine.reject(req.user, Number(req.params.id), { reason: req.body.reason ?? null, ip: req.ip })));
actionsRouter.post('/execution/executions/:id/retry', validate({ params: idParams }), async (req, res) => res.json(await engine.retry(req.user, Number(req.params.id), { ip: req.ip })));

// One item: evidence trail, review, status.
actionsRouter.get('/:id', validate({ params: idParams }), async (req, res) => res.json(await center.detail(req.user, Number(req.params.id))));
actionsRouter.patch('/:id', validate({ params: idParams, body: editSchema }), async (req, res) => res.json(await center.edit(req.user, Number(req.params.id), req.body, { ip: req.ip })));
actionsRouter.post('/:id/approve', validate({ params: idParams }), async (req, res) => res.json(await center.review(req.user, Number(req.params.id), 'approve', { ip: req.ip })));
actionsRouter.post('/:id/reject', validate({ params: idParams, body: reasonSchema }), async (req, res) => res.json(await center.review(req.user, Number(req.params.id), 'reject', { reason: req.body.reason ?? null, ip: req.ip })));
actionsRouter.post('/:id/reopen', validate({ params: idParams }), async (req, res) => res.json(await center.review(req.user, Number(req.params.id), 'reopen', { ip: req.ip })));
actionsRouter.post('/:id/status', validate({ params: idParams, body: z.object({ status: z.enum(['todo', 'in_progress', 'blocked', 'done']) }).strict() }), async (req, res) => res.json(await center.setTaskStatus(req.user, Number(req.params.id), req.body.status, { ip: req.ip })));
