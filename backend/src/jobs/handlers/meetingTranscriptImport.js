// meeting.transcript_import { recordId }: imports the transcript of one synced Teams meeting
// (services/transcripts/importer.js). Queued by the worker's scheduler.
import { importRecord, markFailed } from '../../services/transcripts/importer.js';

export const meetingTranscriptImport = {
  async run(job) {
    await importRecord(job.payload.recordId);
  },
  async onFailure(job, err, { final }) {
    if (final) await markFailed(job.payload.recordId, err);
  },
};
