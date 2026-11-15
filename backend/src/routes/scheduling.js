import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { listGroups } from '../services/groups/index.js';
import { calendarOptions } from '../services/scheduling/calendars.js';
import * as scheduling from '../services/scheduling/index.js';
import { id, idParams } from '../utils/validation.js';
import { searchPeople } from './groups.js';

const ids = z.array(id).max(1000);
const meetingSchema = z
  .object({
    title: z.string().trim().min(1, 'Required').max(255),
    startAt: z.iso.datetime({ offset: true }),
    durationMinutes: z.coerce.number().int().min(5).max(24 * 60),
    timeZone: z.string().trim().min(1).max(64),
    provider: z.enum(['workagent', 'outlook', 'google_calendar']).default('workagent'),
    connectionId: id.nullable().optional(),
    projectId: id.nullable().optional(),
    attendees: z.object({ userIds: ids.default([]), groupIds: ids.default([]) }).strict(),
    excludedUserIds: ids.default([]),
    recurrence: z.object({ frequency: z.enum(['daily', 'weekly']), interval: z.number().int().min(1).max(4).default(1), count: z.number().int().min(2).max(52) }).strict().nullable().optional(),
    membershipMode: z.enum(['dynamic', 'pinned']).default('pinned'),
    checkAvailability: z.boolean().optional(),
  })
  .strict();
const confirmSchema = meetingSchema.extend({ confirm: z.literal(true), recipientsHash: z.string().regex(/^[0-9a-f]{64}$/), largeConfirmed: z.boolean().default(false) });

const sendLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (req) => `schedule:${req.user.id}` });

// Mounted at /scheduling behind requireAuth: every signed-in person can schedule meetings with the
// groups they may see; invitations go out from their own calendar connection or inside WorkAgent.
export const schedulingRouter = Router();

schedulingRouter.get('/calendars', async (req, res) => res.json({ calendars: await calendarOptions(req.user) }));

// Combined attendee picker: people and groups in one list, each with a type.
schedulingRouter.get('/attendees/search', validate({ query: z.object({ q: z.string().trim().min(1).max(100) }).strict() }), async (req, res) => {
  const [people, groups] = await Promise.all([searchPeople(req.query.q), listGroups(req.user, { q: req.query.q })]);
  res.json({
    results: [
      ...people.map((p) => ({ kind: 'person', id: p.id, label: p.fullName, detail: [p.jobTitle, p.department, p.email].filter(Boolean).join(' · ') })),
      ...groups.slice(0, 20).map((g) => ({ kind: g.type, id: g.id, label: g.name, memberCount: g.memberCount, source: g.source })),
    ],
  });
});

schedulingRouter.post('/meetings/preview', validate({ body: meetingSchema }), async (req, res) => res.json(await scheduling.previewMeeting(req.user, req.body)));
schedulingRouter.post('/meetings', sendLimiter, validate({ body: confirmSchema }), async (req, res) => {
  const { meetingId } = await scheduling.scheduleMeeting(req.user, req.body, { ip: req.ip });
  res.status(201).json(await scheduling.getScheduled(req.user, meetingId));
});
schedulingRouter.get('/meetings', validate({ query: z.object({ scope: z.enum(['mine', 'all']).default('mine') }).strict() }), async (req, res) => res.json({ meetings: await scheduling.listScheduled(req.user, req.query) }));
schedulingRouter.get('/meetings/:id', validate({ params: idParams }), async (req, res) => res.json(await scheduling.getScheduled(req.user, req.params.id)));
schedulingRouter.post('/meetings/:id/cancel', validate({ params: idParams, body: z.object({ reason: z.string().trim().max(500).optional() }).strict() }), async (req, res) => res.json(await scheduling.cancelMeeting(req.user, req.params.id, { ip: req.ip, reason: req.body.reason ?? null })));
