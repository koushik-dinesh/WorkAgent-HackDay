// Job 'vexa.auto_scan' {}: one discovery + dispatch pass of automatic Vexa transcription
// (services/vexa/autoTranscribe.js). Queued by the worker's feature tick and by "Sync now".
import { scan } from '../../services/vexa/autoTranscribe.js';
import { logger } from '../../utils/logger.js';

async function run() {
  const out = await scan();
  if (out.dispatched || out.failed || out.cancelled || out.missed) logger.info('vexa auto scan', out);
}

export const vexaAutoScan = { run };
