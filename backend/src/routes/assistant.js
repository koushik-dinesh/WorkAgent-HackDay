import express, { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import * as assistant from '../services/assistant/index.js';
import { MAX_AUDIO_BYTES, transcribe } from '../services/speech/index.js';
import { id, idParams } from '../utils/validation.js';

const messageSchema = z.object({ conversationId: id.nullable().optional(), text: z.string().trim().min(1, 'Say or type a request').max(2000), inputMode: z.enum(['text', 'voice']).default('text') }).strict();
const chooseSchema = z.object({ key: z.string().min(1).max(64), optionId: z.union([z.string().max(200), z.number()]) }).strict();
const reviseSchema = z.object({ provider: z.enum(['workagent', 'outlook', 'google_calendar']).optional(), connectionId: id.nullable().optional(), excludedUserIds: z.array(id).max(1000).optional() }).strict();
const confirmSchema = z.object({ largeConfirmed: z.boolean().default(false) }).strict();

// Each message is one WorkAPI call: limit per person.
const messageLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `assistant:${req.user.id}` });
const writeLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `assistant-write:${req.user.id}` });
const speechLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (req) => `speech:${req.user.id}` });

// Mounted at /assistant behind requireAuth. Conversations and commands are private to their owner.
export const assistantRouter = Router();

assistantRouter.get('/capabilities', async (req, res) => res.json(await assistant.capabilities(req.user)));
assistantRouter.get('/conversations', async (req, res) => res.json({ conversations: await assistant.listConversations(req.user) }));
assistantRouter.get('/conversations/:id', validate({ params: idParams }), async (req, res) => res.json(await assistant.getConversation(req.user, req.params.id)));
assistantRouter.delete('/conversations/:id', validate({ params: idParams }), async (req, res) => {
  await assistant.deleteConversation(req.user, req.params.id);
  res.status(204).end();
});
assistantRouter.post('/messages', messageLimiter, validate({ body: messageSchema }), async (req, res) => res.json(await assistant.handleMessage(req.user, req.body, { ip: req.ip })));
assistantRouter.post('/commands/:id/choose', validate({ params: idParams, body: chooseSchema }), async (req, res) => res.json(await assistant.choose(req.user, req.params.id, req.body)));
assistantRouter.post('/commands/:id/revise', validate({ params: idParams, body: reviseSchema }), async (req, res) => res.json(await assistant.revise(req.user, req.params.id, req.body)));
assistantRouter.post('/commands/:id/confirm', writeLimiter, validate({ params: idParams, body: confirmSchema }), async (req, res) => res.json(await assistant.confirm(req.user, req.params.id, req.body, { ip: req.ip })));
assistantRouter.post('/commands/:id/cancel', validate({ params: idParams }), async (req, res) => res.json(await assistant.cancel(req.user, req.params.id, { ip: req.ip })));
assistantRouter.post('/commands/:id/undo', writeLimiter, validate({ params: idParams }), async (req, res) => res.json(await assistant.undoCommand(req.user, req.params.id, { ip: req.ip })));
// Voice: a short recording (webm/ogg opus, wav, flac) -> text. Audio is not stored.
assistantRouter.post('/transcribe', speechLimiter, express.raw({ type: 'audio/*', limit: MAX_AUDIO_BYTES }), async (req, res) => res.json(await transcribe(req.body, req.get('content-type'))));
// Audit of every command (admins).
assistantRouter.get('/commands', requireRole('admin'), async (req, res) => res.json({ commands: await assistant.listCommands() }));
