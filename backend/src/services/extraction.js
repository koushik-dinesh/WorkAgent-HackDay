// Queuing an AI extraction for a meeting. Shared by the admin "Extract" endpoint and the Vexa
// pipeline (Phase 7), so both apply the same checks and the same duplicate protection.
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import * as queue from '../jobs/queue.js';
import * as runs from '../repositories/extractionRunsRepository.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as transcripts from '../repositories/transcriptsRepository.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { PROMPT_VERSION } from './ai/extractionPrompt.js';
import { audit } from './audit.js';
import { workapi } from './workapi/index.js';

// Meeting statuses from which an admin may (re)run extraction. 'extracting' means one is
// already queued or running; later statuses (approved, emails_sent) are past review.
export const EXTRACTABLE_STATUSES = ['transcript_ready', 'review_pending', 'failed'];

export const dedupeKeyFor = (meetingId) => `ai.extract:meeting:${meetingId}`;

/**
 * Creates an extraction run + ai.extract job and moves the meeting to 'extracting', in one
 * transaction holding the meeting row lock. Throws AppError when not allowed.
 * @returns {{ runId, jobId, previousStatus }}
 */
export async function requestExtraction(meetingId, { requestedBy }) {
  if (!workapi.isConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI extraction is not configured on the server (WORKAPI_PROVIDER, WORKAPI_API_KEY, WORKAPI_MODEL)');
  }
  try {
    return await withTransaction(async (conn) => {
      const meeting = await meetings.findByIdForUpdate(conn, meetingId);
      if (!meeting) throw notFound('Meeting not found');
      if (meeting.status === 'extracting') {
        throw new AppError(409, 'EXTRACTION_IN_PROGRESS', 'Extraction is already queued or running for this meeting');
      }
      const size = await transcripts.textLength(meetingId, conn);
      if (!size) throw new AppError(409, 'TRANSCRIPT_REQUIRED', 'Upload a transcript before extracting action items');
      if (!EXTRACTABLE_STATUSES.includes(meeting.status)) {
        throw conflict(`Action items cannot be extracted while the meeting is "${meeting.status}"`);
      }
      // Rough upper bound of the rendered prompt (each line gains a "[S123] " reference).
      if (size.chars + size.segments * 8 > config.extraction.maxTranscriptChars) {
        throw new AppError(422, 'TRANSCRIPT_TOO_LARGE', 'The transcript is too long to extract from in one request');
      }

      const runId = await runs.create(conn, { meetingId, requestedBy, model: workapi.model(), promptVersion: PROMPT_VERSION });
      const jobId = await queue.enqueue('ai.extract', { meetingId, runId }, { dedupeKey: dedupeKeyFor(meetingId), conn });
      await runs.setJob(conn, runId, jobId);
      await meetings.update(conn, meetingId, { status: 'extracting', lastError: null });
      return { runId, jobId, previousStatus: meeting.status };
    });
  } catch (err) {
    // A concurrent request won the unique dedupe_key.
    if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EXTRACTION_IN_PROGRESS', 'Extraction is already queued or running for this meeting');
    throw err;
  }
}

/**
 * Automatic extraction after a transcript arrived from a meeting bot or a connected tool. Every
 * transcript source goes through here, so they share the same checks and duplicate protection.
 * Never approves or emails. Returns 'queued' | 'not_configured' | 'skipped'.
 * @param trigger short label for the audit entry, e.g. 'vexa_transcript', 'microsoft_teams_transcript'
 */
export async function queueAutoExtraction(meetingId, { trigger }) {
  if (!workapi.isConfigured()) return 'not_configured';
  try {
    const r = await requestExtraction(meetingId, { requestedBy: null });
    await audit({ action: 'extraction.requested', entityType: 'meeting', entityId: meetingId, before: { status: r.previousStatus }, after: { status: 'extracting', runId: r.runId, jobId: r.jobId, trigger } });
    return 'queued';
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn('auto extraction not queued', { meetingId, code: err.code, trigger });
      return 'skipped';
    }
    throw err;
  }
}
