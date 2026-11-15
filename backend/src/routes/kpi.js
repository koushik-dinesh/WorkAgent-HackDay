import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import * as kpi from '../services/kpi/index.js';
import { id, idParams } from '../utils/validation.js';

const metricKey = z.enum(Object.keys(kpi.METRICS));
const sourceType = z.enum(['action_item', 'external_record', 'meeting']);

// Mounted at /kpi behind requireAuth. Every route is scoped in services/kpi (self / team lead / HR).
export const kpiRouter = Router();

kpiRouter.get('/status', async (req, res) => res.json(await kpi.status(req.user)));
kpiRouter.post('/notice/acknowledge', async (req, res) => res.json(await kpi.acknowledgeNotice(req.user, req.ip)));

// The person's own data.
kpiRouter.get('/me', async (req, res) => res.json(await kpi.myDashboard(req.user)));
kpiRouter.get('/me/sources', validate({ query: z.object({ metric: metricKey, periodDays: z.coerce.number().int().refine((v) => kpi.PERIODS.includes(v)) }).strict() }), async (req, res) => res.json(await kpi.metricSources(req.user, req.user.id, req.query.metric, req.query.periodDays)));
kpiRouter.post('/me/corrections', validate({ body: z.object({ sourceType, sourceId: id, reason: z.string().trim().min(3).max(1000) }).strict() }), async (req, res) => res.json(await kpi.flagEvent(req.user, req.body, req.ip)));
kpiRouter.delete('/me/corrections/:id', validate({ params: idParams }), async (req, res) => res.json(await kpi.restoreEvent(req.user, req.params.id, req.ip)));

// Team leads (manager role) and admins.
kpiRouter.get('/teams/:id', validate({ params: idParams }), async (req, res) => res.json(await kpi.teamDashboard(req.user, req.params.id)));
kpiRouter.get('/teams/:id/members/:userId', validate({ params: z.object({ id, userId: id }) }), async (req, res) => res.json(await kpi.individualView(req.user, req.params.userId, { teamId: req.params.id })));

// HR (users with HR access) and admins: aggregates; an individual view needs a reason.
kpiRouter.get('/hr', async (req, res) => res.json(await kpi.hrDashboard(req.user)));
kpiRouter.post('/hr/individual', validate({ body: z.object({ userId: id, reason: z.string().trim().min(10, 'Give a reason (at least 10 characters)').max(500) }).strict() }), async (req, res) => res.json(await kpi.individualView(req.user, req.body.userId, { reason: req.body.reason })));

// Administration: consent, settings, computation, exit deletion.
kpiRouter.post('/consent', requireRole('admin'), validate({ body: z.object({ statement: z.string().trim().min(20, 'Describe the consent (at least 20 characters)').max(2000), confirm: z.literal(true) }).strict() }), async (req, res) => res.json(await kpi.recordConsent(req.user, req.body, req.ip)));
kpiRouter.delete('/consent', requireRole('admin'), async (req, res) => res.json(await kpi.withdrawConsent(req.user, req.ip)));
kpiRouter.put('/settings', requireRole('admin'), validate({ body: z.object({ enabled: z.boolean().optional(), retentionDays: z.number().int().min(30).max(3650).optional(), minTeamSize: z.number().int().min(3).max(50).optional(), noticeText: z.string().trim().min(100).max(10_000).optional() }).strict() }), async (req, res) => res.json(await kpi.updateSettings(req.user, req.body, req.ip)));
kpiRouter.post('/compute', requireRole('admin'), async (req, res) => res.status(202).json(await kpi.queueCompute(req.user.id)));
kpiRouter.delete('/employees/:id/data', requireRole('admin'), validate({ params: idParams }), async (req, res) => {
  await kpi.deleteEmployeeData(req.params.id, { actorId: req.user.id, ip: req.ip });
  await audit({ actorUserId: req.user.id, action: 'kpi.exit_deletion_requested', entityType: 'user', entityId: req.params.id, ip: req.ip });
  res.status(204).end();
});
