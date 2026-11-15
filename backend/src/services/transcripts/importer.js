// Meeting transcripts from connected tools (Microsoft Teams), imported into
// the same pipeline as uploads and the Vexa bot:
//
//   synced meeting record ──fetchTranscript()──▶ shared parser ──▶ WorkAgent meeting + transcript
//     ──▶ queueAutoExtraction() (same as Vexa) ──▶ WorkAPI ──▶ validator ──▶ human review
//
// - Which records: connectors that implement fetchTranscript(ctx, record) and name their meeting
//   record types in `transcriptRecordTypes`. Only records of resources an admin enabled, of active
//   connections, that ended in the last TRANSCRIPT_IMPORT_LOOKBACK_DAYS days.
// - One import per record (meeting_transcript_imports). A transcript that is not ready yet is
//   checked again every RECHECK_MS for up to GIVE_UP_AFTER_MS after the meeting ended.
// - A meeting row is created for the record (platform = provider, native id = record id) or found
//   again by that identity; an existing transcript is never overwritten.
// - Never approves, emails or writes to the provider.
import { config } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import * as queue from '../../jobs/queue.js';
import { PermanentJobError, RescheduleJob } from '../../jobs/queue.js';
import * as connections from '../../repositories/integrationConnectionsRepository.js';
import * as records from '../../repositories/externalRecordsRepository.js';
import * as imports from '../../repositories/transcriptImportsRepository.js';
import * as meetings from '../../repositories/meetingsRepository.js';
import * as transcripts from '../../repositories/transcriptsRepository.js';
import { logger } from '../../utils/logger.js';
import { audit } from '../audit.js';
import { queueAutoExtraction } from '../extraction.js';
import { buildContext } from '../integrations/context.js';
import { ProviderError } from '../integrations/errors.js';
import { createLink } from '../integrations/links.js';
import { registry as defaultRegistry } from '../integrations/registry.js';
import { TranscriptParseError, parseTranscript, renderFullText } from './parser.js';

export const JOB_TYPE = 'meeting.transcript_import';
export const RECHECK_MS = 15 * 60 * 1000;
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
export const importJobKey = (recordId) => `${JOB_TYPE}:record:${recordId}`;

// Meetings in these states may receive an imported transcript (same rule as manual uploads).
const ACCEPTS_TRANSCRIPT = ['draft', 'ended', 'failed'];

/** Provider/record-type pairs whose transcripts can be imported (from the registry). */
export function transcriptKinds(registry = defaultRegistry) {
  return registry
    .list()
    .filter((p) => p.available)
    .map((p) => registry.get(p.id))
    .filter((c) => typeof c.fetchTranscript === 'function' && Array.isArray(c.transcriptRecordTypes))
    .flatMap((c) => c.transcriptRecordTypes.map((recordType) => ({ provider: c.id, recordType })));
}

/** Queues an import job for every due record. Returns how many were queued. */
export async function enqueueDue({ registry = defaultRegistry, limit = 20 } = {}) {
  const ids = await imports.findDue({ kinds: transcriptKinds(registry), lookbackDays: config.integrations.transcriptLookbackDays, limit });
  let queued = 0;
  for (const recordId of ids) {
    try {
      await queue.enqueue(JOB_TYPE, { recordId }, { dedupeKey: importJobKey(recordId) });
      queued++;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  return queued;
}

const meetingEnd = (record) => {
  const t = Date.parse(record.metadata?.end ?? '');
  return Number.isNaN(t) ? null : t;
};

/** What to call the meeting. (Google Meet conferences are no longer synced: Vexa transcribes them.) */
async function titleFor(_conn, record) {
  return record.title || 'Imported meeting';
}

/** Active WorkAgent users whose email is among the meeting's organizer/attendees. */
async function participantIds(conn, record) {
  const emails = [...new Set([record.metadata?.organizer, ...(record.metadata?.attendees ?? [])].filter((e) => typeof e === 'string' && e.includes('@')).map((e) => e.toLowerCase()))];
  if (!emails.length) return [];
  const [rows] = await conn.query('SELECT id FROM users WHERE is_active = TRUE AND LOWER(email) IN (?)', [emails]);
  return rows.map((r) => r.id);
}

async function creatorFor(conn, connection) {
  if (connection.connectedBy) return connection.connectedBy;
  const [rows] = await conn.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1");
  if (!rows[0]) throw new PermanentJobError('No active admin to own the imported meeting');
  return rows[0].id;
}

async function finish(recordId, status, fields = {}) {
  await withTransaction((conn) => imports.save(conn, recordId, { status, nextCheckAt: null, ...fields }));
  return status;
}

/**
 * Imports the transcript of one synced meeting record. Returns
 * 'imported' | 'already_imported' | 'waiting' | 'none' | 'failed' | 'skipped'.
 * Throws RescheduleJob (rate limit) or a retryable error (provider unavailable).
 */
export async function importRecord(recordId, { registry = defaultRegistry, now = Date.now() } = {}) {
  const record = await records.findById(recordId);
  if (!record) return 'skipped';
  const state = await imports.find(recordId);
  if (state && state.status !== 'waiting') return state.status === 'imported' ? 'already_imported' : state.status;
  if (record.sourceDeletedAt) return finish(recordId, 'none', { lastError: 'The meeting was deleted at the source' });

  const connection = await connections.findById(record.connectionId);
  if (!connection || connection.status !== 'active' || !connection.isEnabled) return 'skipped';
  const connector = registry.getAvailable(record.provider);
  if (!connector?.fetchTranscript) return finish(recordId, 'failed', { lastError: `Provider ${record.provider} is not available: ${registry.problem(record.provider) ?? 'no transcript support'}` });

  const attempts = (state?.attempts ?? 0) + 1;
  let result;
  try {
    result = await connector.fetchTranscript(buildContext(connector, connection), record);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === 'rate_limited') throw new RescheduleJob(err.waitMs(), 'provider rate limit');
    if (err.kind === 'transient') throw err;
    if (err.kind === 'not_found') return finish(recordId, 'none', { attempts, lastError: 'The provider has no transcript for this meeting' });
    // forbidden (missing consent / not allowed), auth, invalid request/response: a person must act.
    const hint = err.kind === 'forbidden' ? ' Check that the required permissions were granted with admin consent (runbook §12).' : '';
    logger.warn('transcript import failed', { recordId, provider: record.provider, kind: err.kind, error: err.message });
    return finish(recordId, 'failed', { attempts, lastError: `${err.publicMessage}${hint}` });
  }

  if (result.status === 'none') return finish(recordId, 'none', { attempts, lastError: result.reason ?? 'No transcript' });
  if (result.status === 'not_ready') {
    const end = meetingEnd(record);
    if (end !== null && now - end > GIVE_UP_AFTER_MS) {
      return finish(recordId, 'none', { attempts, lastError: 'No transcript appeared within 24 hours of the meeting (transcription may have been off)' });
    }
    await withTransaction((conn) => imports.save(conn, recordId, { status: 'waiting', attempts, nextCheckAt: new Date(now + RECHECK_MS), lastError: null }));
    return 'waiting';
  }

  let parsed;
  try {
    parsed = parseTranscript(result.content, { format: result.format });
  } catch (err) {
    if (err instanceof TranscriptParseError) return finish(recordId, 'failed', { attempts, lastError: `The transcript could not be read: ${err.message}` });
    throw err;
  }

  const saved = await withTransaction(async (conn) => {
    const current = await imports.find(recordId, { conn, forUpdate: true });
    if (current && current.status !== 'waiting') return { outcome: 'already_imported' };

    const platform = record.provider;
    const nativeId = String(record.externalId).slice(0, 255);
    const [[existing]] = await conn.query('SELECT id, status FROM meetings WHERE platform = ? AND native_meeting_id = ? ORDER BY id LIMIT 1 FOR UPDATE', [platform, nativeId]);
    let meetingId = existing?.id ?? null;
    if (meetingId && (!ACCEPTS_TRANSCRIPT.includes(existing.status) || (await transcripts.textLength(meetingId, conn))?.chars)) {
      // Never overwrite: the meeting already has a transcript or has moved on in review.
      await imports.save(conn, recordId, { status: 'imported', attempts, meetingId, transcriptRef: result.transcriptRef, nextCheckAt: null, lastError: 'The meeting already had a transcript; nothing was replaced' });
      return { outcome: 'already_imported', meetingId };
    }
    const start = record.metadata?.start ? new Date(record.metadata.start) : null;
    const end = meetingEnd(record) !== null ? new Date(meetingEnd(record)) : null;
    if (!meetingId) {
      meetingId = await meetings.create(conn, {
        title: (await titleFor(conn, record)).slice(0, 255),
        meetingUrl: String(record.metadata?.joinUrl ?? record.url ?? '').slice(0, 1024),
        scheduledAt: start,
        projectId: record.projectId,
        createdBy: await creatorFor(conn, connection),
      });
      await meetings.replaceParticipants(conn, meetingId, await participantIds(conn, record));
    }
    await transcripts.replaceForMeeting(conn, meetingId, {
      fullText: renderFullText(parsed.segments),
      rawJson: { source: record.provider, format: parsed.format, recordId: record.id, transcriptRef: result.transcriptRef, ...(parsed.raw !== undefined ? { data: parsed.raw } : { content: result.content }) },
      detectedLanguages: [...new Set(parsed.segments.map((s) => s.language).filter(Boolean))],
      segments: parsed.segments,
    });
    await meetings.update(conn, meetingId, { status: 'transcript_ready', platform, nativeMeetingId: nativeId, startedAt: start ?? undefined, endedAt: end ?? undefined, lastError: null });
    await createLink(conn, { from: { type: 'meeting', id: meetingId }, to: { type: 'external_record', id: record.id }, linkType: 'same_as', origin: 'source' });
    await imports.save(conn, recordId, { status: 'imported', attempts, meetingId, transcriptRef: result.transcriptRef, nextCheckAt: null, lastError: null });
    return { outcome: 'imported', meetingId, created: !existing };
  });

  if (saved.outcome !== 'imported') return saved.outcome;
  await audit({
    action: 'transcript.imported_from_integration',
    entityType: 'meeting',
    entityId: saved.meetingId,
    after: { provider: record.provider, recordId: record.id, transcriptRef: result.transcriptRef, segments: parsed.segments.length, meetingCreated: saved.created },
  });
  if (config.integrations.transcriptAutoExtract) await queueAutoExtraction(saved.meetingId, { trigger: `${record.provider}_transcript` });
  logger.info('meeting transcript imported', { recordId, provider: record.provider, meetingId: saved.meetingId, segments: parsed.segments.length });
  return 'imported';
}

/** After the job gave up on retryable errors: record it so the meeting is not tried forever. */
export async function markFailed(recordId, err) {
  await withTransaction((conn) => imports.save(conn, recordId, { status: 'failed', nextCheckAt: null, lastError: err?.publicMessage ?? err?.message ?? 'Import failed' }));
}
