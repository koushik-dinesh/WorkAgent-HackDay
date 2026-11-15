// duplicates.scan               new work since the last scan (creation-time detection, every 15 min)
// duplicates.sweep              nightly: all open work, then threshold tuning from feedback
// meeting.decisions_extract     decisions of a meeting (after action-item extraction)
import { scanNew, sweep } from '../../services/duplicates/index.js';
import { extractDecisions } from '../../services/decisions.js';

export const duplicatesScan = { run: async () => scanNew() };
export const duplicatesSweep = { run: async () => sweep() };
export const decisionsExtract = { run: async (job) => extractDecisions(job.payload.meetingId) };
