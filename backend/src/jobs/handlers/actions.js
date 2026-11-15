// Action intelligence and execution jobs (docs/ACTION_INTELLIGENCE.md).
//   action.execute       { planId }  runs an approved plan (services/execution); reschedules itself
//                                    for the cancel window and for automatic retries
//   actions.source_scan  {}          action items from Teams/Jira/GitHub/Figma/Outlook records,
//                                    progress/completion evidence from linked work, and read-back
//                                    verification of executions that could not be verified at once
import { runPlan, verifyPending } from '../../services/execution/index.js';
import { refresh as refreshProgress } from '../../services/actions/progress.js';
import { scan as scanSources } from '../../services/actions/sourceExtraction.js';
import { logger } from '../../utils/logger.js';

export const actionExecute = {
  async run(job) {
    const out = await runPlan(job.payload.planId);
    logger.info('action plan run', { planId: job.payload.planId, ...out });
  },
};

export const actionsSourceScan = {
  async run() {
    const sources = await scanSources();
    const progress = await refreshProgress();
    const verification = await verifyPending();
    if (sources.created || sources.linked || sources.failed || progress.evidence || verification.verified) logger.info('actions source scan', { sources, progress, verification });
  },
};
