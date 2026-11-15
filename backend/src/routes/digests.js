import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as digest from '../services/digest/index.js';
import { isTimeZone } from '../services/notifications/inbox.js';
import { idParams } from '../utils/validation.js';

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    timeZone: z.string().refine(isTimeZone, 'Use an IANA time zone').optional(),
    audiences: z.object({ manager: z.boolean(), hr: z.boolean(), executive: z.boolean() }).partial().optional(),
  })
  .strict();
const prefsSchema = z.object({ suppressedSections: z.array(z.enum(digest.SECTIONS)).max(digest.SECTIONS.length).optional(), email: z.boolean().optional(), teams: z.boolean().optional() }).strict();

// Mounted at /digests behind requireAuth. Recipients see their digests; admins see all.
export const digestsRouter = Router();

digestsRouter.get('/', async (req, res) => res.json({ digests: await digest.listDigests(req.user), sections: digest.SECTIONS.map((key) => ({ key, label: digest.SECTION_LABELS[key] })) }));
digestsRouter.get('/preferences', async (req, res) => res.json({ preferences: await digest.subscription(req.user.id), sections: digest.SECTIONS.map((key) => ({ key, label: digest.SECTION_LABELS[key] })) }));
digestsRouter.put('/preferences', validate({ body: prefsSchema }), async (req, res) => res.json({ preferences: await digest.setSubscription(req.user, req.body) }));
digestsRouter.get('/settings', requireRole('admin'), async (req, res) => res.json({ settings: await digest.getSettings() }));
digestsRouter.put('/settings', requireRole('admin'), validate({ body: settingsSchema }), async (req, res) => res.json({ settings: await digest.updateSettings(req.user, req.body, req.ip) }));
digestsRouter.post('/generate', requireRole('admin'), validate({ body: z.object({ periodEnd: z.iso.datetime({ offset: true }).optional() }).strict() }), async (req, res) => res.status(202).json(await digest.queueGenerate(req.user, req.body.periodEnd)));
digestsRouter.get('/:id', validate({ params: idParams }), async (req, res) => res.json(await digest.getDigest(req.user, req.params.id)));
