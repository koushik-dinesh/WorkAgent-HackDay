import { Router } from 'express';
import { z } from 'zod';
import * as queue from '../jobs/queue.js';
import { requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import * as duplicates from '../services/duplicates/index.js';
import { conflict } from '../utils/errors.js';
import { id, idParams } from '../utils/validation.js';

const itemRef = z.object({ type: z.enum(['external_record', 'action_item', 'meeting_decision']), id }).strict();
const listQuery = z
  .object({
    tier: z.enum(['high', 'medium', 'low']).optional(),
    status: z.enum(['open', 'dismissed', 'linked', 'all']).default('open'),
    itemType: z.enum(['external_record', 'action_item', 'meeting_decision']).optional(),
    itemId: id.optional(),
  })
  .strict();
const queryLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (req) => `dup-query:${req.user.id}` });

// Mounted at /duplicates behind requireAuth. A pair is visible only when both items are.
export const duplicatesRouter = Router();

duplicatesRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const { tier, status, itemType, itemId } = req.query;
  res.json({ candidates: await duplicates.listCandidates(req.user, { tier, status, item: itemType && itemId ? { type: itemType, id: itemId } : null }) });
});
duplicatesRouter.get('/status', requireRole('admin'), async (req, res) => res.json(await duplicates.status()));
// "Is anyone else working on this?" — free text or an existing item.
duplicatesRouter.post('/query', queryLimiter, validate({ body: z.object({ text: z.string().trim().min(3).max(2000).optional(), item: itemRef.optional() }).strict().refine((v) => v.text || v.item, 'Give a text or an item') }), async (req, res) => res.json(await duplicates.query(req.user, req.body)));
duplicatesRouter.post('/sweep', requireRole('admin'), async (req, res) => {
  try {
    const jobId = await queue.enqueue(duplicates.SWEEP_JOB, {}, { dedupeKey: duplicates.SWEEP_JOB });
    await audit({ actorUserId: req.user.id, action: 'duplicates.sweep_requested', entityType: 'settings', ip: req.ip });
    res.status(202).json({ jobId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('A sweep is already queued');
    throw err;
  }
});
duplicatesRouter.post('/reindex', requireRole('admin'), async (req, res) => res.json(await duplicates.reindex(req.user, req.ip)));
duplicatesRouter.get('/:id', validate({ params: idParams }), async (req, res) => res.json({ candidate: await duplicates.getCandidate(req.user, req.params.id) }));
duplicatesRouter.post('/:id/dismiss', validate({ params: idParams, body: z.object({ reason: z.string().trim().max(500).optional() }).strict() }), async (req, res) => res.json({ candidate: await duplicates.dismiss(req.user, req.params.id, req.body.reason, req.ip) }));
duplicatesRouter.post('/:id/link', validate({ params: idParams }), async (req, res) => res.json({ candidate: await duplicates.link(req.user, req.params.id, req.ip) }));
