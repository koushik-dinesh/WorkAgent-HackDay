// action_item.export { exportId }: creates an approved action item as a Jira issue
// (services/externalTasks.js). Queued only by an admin's explicit request.
import { markExportFailed, runExport } from '../../services/externalTasks.js';

export const actionItemExport = {
  async run(job) {
    await runExport(job.payload.exportId);
  },
  async onFailure(job, err, { final }) {
    if (final) await markExportFailed(job.payload.exportId, err);
  },
};
