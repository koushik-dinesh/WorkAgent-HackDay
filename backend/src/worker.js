// Background worker: polls the MySQL jobs table and runs handlers. Start with `npm run worker`.
// Several workers may run at once; claiming is safe (SKIP LOCKED).
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { handlersFor } from './jobs/handlers/index.js';
import * as queue from './jobs/queue.js';
import { processNext, recover } from './jobs/runner.js';
import { registry } from './services/integrations/registry.js';
import * as scheduler from './services/integrations/scheduler.js';
import * as transcriptImporter from './services/transcripts/importer.js';
import * as featureSchedule from './services/featureSchedule.js';
import { enqueueScan as enqueueVexaScan } from './services/vexa/autoTranscribe.js';
import { workapi } from './services/workapi/index.js';
import { logger } from './utils/logger.js';

const workerId = `${hostname()}:${process.pid}`.slice(0, 64);
const RECOVER_EVERY_MS = 60_000;
const SCHEDULE_EVERY_MS = 60_000;
const MAINTENANCE_EVERY_MS = 6 * 60 * 60 * 1000;
const NOTIFICATION_SCAN_EVERY_MS = 60 * 60 * 1000;
const TRANSCRIPT_IMPORT_EVERY_MS = 5 * 60 * 1000;
// Features 2-6: digest cut-off, duplicate scans/sweeps, KPI nightly, directory sync, dynamic invitations.
const FEATURE_TICK_EVERY_MS = 5 * 60 * 1000;
// Automatic Vexa transcription and action-item analysis of synced records: every minute, so a
// bot can be sent a couple of minutes before a meeting starts.
const VEXA_SCAN_EVERY_MS = 60_000;
// WORKER_JOB_TYPES lets a deployment dedicate workers (e.g. one only for integrations).
const handlers = handlersFor(config.jobs.workerTypes);
let stopping = false;

async function checkAi() {
  if (!handlers['ai.extract']) return;
  if (config.workapi.legacyVariables.length) {
    logger.warn('pre-WorkAPI AI variables are set but no longer read; use WORKAPI_* instead (docs/WORKAPI.md)', { variables: config.workapi.legacyVariables });
  }
  if (!workapi.isConfigured()) {
    logger.warn('WorkAPI is not configured (WORKAPI_PROVIDER, WORKAPI_API_KEY, WORKAPI_MODEL); ai.extract jobs will fail until it is');
    return;
  }
  try {
    const verified = await workapi.verify();
    logger.info('workapi provider verified', verified);
  } catch (err) {
    // Keep running: jobs fail with a clear error, and other job types are unaffected.
    logger.error('workapi provider check failed', { provider: workapi.provider(), model: workapi.model(), kind: err.kind ?? err.name, error: err.message });
  }
}

async function main() {
  logger.info('worker starting', { workerId, types: Object.keys(handlers), pollMs: config.jobs.pollIntervalMs });
  await checkAi();
  const runsSync = Boolean(handlers['integration.sync']);
  if (runsSync) {
    const providers = registry.list();
    logger.info('integration providers', { providers: providers.map((p) => ({ id: p.id, available: p.available, problem: p.problem })) });
  }

  let lastRecover = 0;
  let lastSchedule = 0;
  let lastMaintenance = 0;
  let lastScan = 0;
  let lastImport = 0;
  let lastFeatureTick = 0;
  let lastVexaScan = 0;
  const runsImports = Boolean(handlers['meeting.transcript_import']);
  const runsScan = Boolean(handlers['notifications.scan']);
  const runsMaintenance = Boolean(handlers['integration.maintenance']);
  while (!stopping) {
    try {
      if (Date.now() - lastRecover > RECOVER_EVERY_MS) {
        await recover(handlers);
        lastRecover = Date.now();
      }
      // Only workers that run integration syncs schedule them (several such workers are fine).
      if (runsSync && Date.now() - lastSchedule > SCHEDULE_EVERY_MS) {
        const queued = await scheduler.tick();
        if (queued) logger.info('integration syncs queued', { queued });
        lastSchedule = Date.now();
      }
      if (runsMaintenance && Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
        await scheduler.enqueueMaintenance();
        lastMaintenance = Date.now();
      }
      if (runsScan && Date.now() - lastScan > NOTIFICATION_SCAN_EVERY_MS) {
        // One pending scan at a time across workers (dedupe key).
        await queue.enqueue('notifications.scan', {}, { dedupeKey: 'notifications.scan' }).catch((err) => {
          if (err.code !== 'ER_DUP_ENTRY') throw err;
        });
        lastScan = Date.now();
      }
      // Meeting transcripts from connected tools (Microsoft Teams; Google Meet goes through Vexa): one job per due meeting.
      if (runsImports && Date.now() - lastImport > TRANSCRIPT_IMPORT_EVERY_MS) {
        const queued = await transcriptImporter.enqueueDue();
        if (queued) logger.info('transcript imports queued', { queued });
        lastImport = Date.now();
      }
      if (handlers['vexa.auto_scan'] && Date.now() - lastVexaScan > VEXA_SCAN_EVERY_MS) {
        await enqueueVexaScan();
        lastVexaScan = Date.now();
      }
      if (Date.now() - lastFeatureTick > FEATURE_TICK_EVERY_MS) {
        const queued = await featureSchedule.tick(handlers);
        if (Object.values(queued).some(Boolean)) logger.info('feature jobs queued', queued);
        lastFeatureTick = Date.now();
      }
      const didWork = await processNext(workerId, handlers);
      if (!didWork) await sleep(config.jobs.pollIntervalMs);
    } catch (err) {
      // Database hiccups: log, back off, keep the worker alive.
      logger.error('worker loop error', { error: err.message });
      await sleep(Math.max(config.jobs.pollIntervalMs, 5000));
    }
  }
  await pool.end();
  logger.info('worker stopped', { workerId });
}

// Finish the current job, then exit. A second signal exits immediately; the job's lease
// expires and another worker picks it up.
function shutdown(signal) {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info('worker stopping after current job', { signal });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  logger.error('worker crashed', { error: err.message });
  process.exit(1);
});
