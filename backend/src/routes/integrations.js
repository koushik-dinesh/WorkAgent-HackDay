import { Router } from 'express';
import * as teamsMock from '../services/integrations/mock/teamsMock.js';
import { overview } from '../services/integrations/overview.js';
import * as vexaAuto from '../services/vexa/autoTranscribe.js';
import { z } from 'zod';
import * as ctrl from '../controllers/integrationsController.js';
import { validate } from '../middleware/validate.js';
import { CONNECTION_STATUSES } from '../repositories/integrationConnectionsRepository.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const provider = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Unknown provider');
const providerParams = z.object({ provider });
const resourceParams = z.object({ id, resourceId: id });

const listQuery = z.object({ provider: provider.optional(), status: z.enum(CONNECTION_STATUSES).optional() }).strict();

// What the provider sent back through the browser. The state is checked server-side; params are
// checked by the connector (e.g. GitHub: installation_id, setup_action).
const callbackSchema = z
  .object({
    state: z.string().min(20).max(200),
    params: z
      .record(z.string().max(64), z.union([z.string().max(4096), z.number()]))
      .refine((p) => Object.keys(p).length <= 20, 'Too many parameters')
      .default({}),
  })
  .strict();

const updateSchema = z
  .object({ isEnabled: z.boolean(), displayName: z.string().trim().min(1).max(200) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const resourceUpdateSchema = z
  .object({ isEnabled: z.boolean().optional(), projectId: optionalNullable(id) })
  .strict()
  .refine((v) => v.isEnabled !== undefined || v.projectId !== undefined, 'Provide isEnabled or projectId');

const disconnectSchema = z.object({ uninstall: z.boolean().default(false) }).strict();

const deliveriesQuery = z
  .object({
    status: z.enum(['received', 'processing', 'processed', 'ignored', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const identitiesQuery = z
  .object({ provider: provider.optional(), unmatched: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') })
  .strict();
const identityMatchSchema = z.object({ userId: optionalNullable(id).transform((v) => v ?? null) }).strict();

// Mounted at /integrations behind requireAuth + requireRole('admin').
export const integrationsRouter = Router();

// Vexa meeting transcription (one-time connection, automatic Google Meet transcription). Before the
// '/:provider/...' routes, which would otherwise capture '/vexa/...'.
const vexaConnectSchema = z.object({ consentStatement: z.string().trim().min(20).max(2000), scope: z.enum(['organizer', 'member_attends']).optional(), internalOnly: z.boolean().optional() }).strict();
const vexaSettingsSchema = z
  .object({
    enabled: z.boolean(),
    scope: z.enum(['organizer', 'member_attends']),
    internalOnly: z.boolean(),
    optOutKeywords: z.array(z.string().trim().min(2).max(40)).max(20),
    joinLeadMinutes: z.number().int().min(0).max(15),
    maxDurationHours: z.number().int().min(1).max(8),
  })
  .partial()
  .strict();
const vexaSessionsQuery = z.object({ state: z.enum(['scheduled', 'dispatching', 'joining', 'recording', 'processing', 'completed', 'failed', 'cancelled', 'skipped']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
integrationsRouter.get('/vexa', async (req, res) => res.json(await vexaAuto.overview()));
integrationsRouter.post('/vexa/connect', validate({ body: vexaConnectSchema }), async (req, res) => res.json(await vexaAuto.connect(req.user, req.body, { ip: req.ip })));
integrationsRouter.post('/vexa/disconnect', async (req, res) => res.json(await vexaAuto.disconnect(req.user, { ip: req.ip })));
integrationsRouter.put('/vexa/settings', validate({ body: vexaSettingsSchema }), async (req, res) => res.json(await vexaAuto.updateSettings(req.user, req.body, { ip: req.ip })));
integrationsRouter.post('/vexa/sync', async (req, res) => res.status(202).json({ queued: await vexaAuto.enqueueScan() }));
integrationsRouter.get('/vexa/sessions', validate({ query: vexaSessionsQuery }), async (req, res) => res.json({ sessions: await vexaAuto.listSessions(req.query) }));
integrationsRouter.post('/vexa/sessions/:id/retry', validate({ params: idParams }), async (req, res) => res.json({ session: await vexaAuto.retrySession(req.user, Number(req.params.id), { ip: req.ip }) }));
integrationsRouter.post('/vexa/sessions/:id/skip', validate({ params: idParams }), async (req, res) => res.json({ session: await vexaAuto.skipSession(req.user, Number(req.params.id), { ip: req.ip }) }));


integrationsRouter.get('/providers', ctrl.listProviders);
integrationsRouter.get('/', validate({ query: listQuery }), ctrl.list);
integrationsRouter.post('/:provider/connect', validate({ params: providerParams }), ctrl.startConnect);
integrationsRouter.post('/:provider/callback', validate({ params: providerParams, body: callbackSchema }), ctrl.completeConnect);

integrationsRouter.post('/webhook-deliveries/:id/replay', validate({ params: idParams }), ctrl.replayDelivery);
// People in connected applications, matched to WorkAgent users (before '/:id', which would capture them).
integrationsRouter.get('/identities', validate({ query: identitiesQuery }), ctrl.listIdentities);
integrationsRouter.patch('/identities/:id', validate({ params: idParams, body: identityMatchSchema }), ctrl.matchIdentity);
// Dashboard cards (state per provider) and the Microsoft Teams DEVELOPMENT MOCK actions.
integrationsRouter.get('/overview', async (req, res) => res.json(await overview()));
integrationsRouter.get('/teams-mock', async (req, res) => res.json(await teamsMock.mockSummary()));
integrationsRouter.get('/teams-mock/teams', async (req, res) => res.json(await teamsMock.mockTeamsView()));
integrationsRouter.post('/teams-mock/sync', async (req, res) => res.json(await teamsMock.syncMock({ actorId: req.user.id })));
integrationsRouter.post('/teams-mock/reset', async (req, res) => res.json({ deleted: await teamsMock.resetMock({ actorId: req.user.id }), summary: await teamsMock.mockSummary() }));
integrationsRouter.get('/:id', validate({ params: idParams }), ctrl.get);
integrationsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), ctrl.update);
integrationsRouter.post('/:id/sync', validate({ params: idParams }), ctrl.syncNow);
integrationsRouter.post('/:id/disconnect', validate({ params: idParams, body: disconnectSchema }), ctrl.disconnect);
integrationsRouter.get('/:id/resources', validate({ params: idParams }), ctrl.listResources);
integrationsRouter.post('/:id/resources/refresh', validate({ params: idParams }), ctrl.refreshResources);
integrationsRouter.patch('/:id/resources/:resourceId', validate({ params: resourceParams, body: resourceUpdateSchema }), ctrl.updateResource);
integrationsRouter.get('/:id/webhook-deliveries', validate({ params: idParams, query: deliveriesQuery }), ctrl.listDeliveries);
