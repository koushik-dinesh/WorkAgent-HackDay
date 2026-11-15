// notifications.scan (Phase 10): hourly overdue-task, failed-job and daily-summary notifications. Idempotent: the
// notifications' dedupe keys make repeated scans harmless.
import { scan } from '../../services/notifications/triggers.js';
import { run as runFollowups } from '../../services/actions/followups.js';
import { logger } from '../../utils/logger.js';

export const notificationsScan = {
  async run() {
    const stats = await scan();
    if (stats.overdue || stats.dead || stats.digests) logger.info('notifications scan', stats);
    // Automated follow-up (reminders, escalations) on the same hourly cadence.
    const followups = await runFollowups();
    if (followups.reminders || followups.overdueEscalations || followups.noProgress || followups.blockerEscalations || followups.emailPlans) logger.info('action follow-ups', followups);
  },
};
