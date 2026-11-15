import { useState } from 'react';
import { requestActionItemExport } from '../../api/actionItems.js';
import { Button, inputClass } from '../ui.jsx';

/**
 * "Create Jira issue" for one approved action item. The admin picks a Jira project (an enabled
 * project of a Jira connection); the issue is created in the background and appears here with its
 * key. Shown only for approved items; nothing is sent to Jira without this explicit action.
 *
 * @param exportInfo the item's export ({ status, externalKey, externalUrl, assigneeSet, lastError }) or null
 * @param targets    [{ resourceId, name, key, canWrite, project }] from /action-items/export-targets
 */
export function JiraExport({ item, exportInfo, targets, onRequested }) {
  const preferred = targets.find((t) => t.project?.id && t.project.id === item.projectId) ?? targets[0];
  const [resourceId, setResourceId] = useState(preferred?.resourceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (exportInfo?.status === 'created') {
    return (
      <p className="text-sm text-slate-700">
        Jira issue{' '}
        <a href={exportInfo.externalUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-900 underline">
          {exportInfo.externalKey}
        </a>
        {exportInfo.assigneeSet === false && <span className="text-slate-500"> · unassigned in Jira (no linked Jira account for the owner)</span>}
      </p>
    );
  }
  if (exportInfo?.status === 'queued') return <p className="text-sm text-slate-600">Creating the Jira issue…</p>;
  if (!targets.length) return <p className="text-xs text-slate-500">To create Jira issues, enable a Jira project on the Jira connection (Admin → Integrations).</p>;

  const target = targets.find((t) => t.resourceId === Number(resourceId));
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { export: created } = await requestActionItemExport(item.id, Number(resourceId));
      onRequested(created);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" aria-label="Create Jira issue">
      {exportInfo?.status === 'failed' && <p className="text-sm text-red-700">Jira issue not created: {exportInfo.lastError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`jira-target-${item.id}`}>
          Jira project
        </label>
        <select id={`jira-target-${item.id}`} className={`${inputClass} w-auto`} value={resourceId} onChange={(e) => setResourceId(e.target.value)} disabled={busy}>
          {targets.map((t) => (
            <option key={t.resourceId} value={t.resourceId}>
              {t.key && t.key !== t.name ? `${t.key} — ` : ''}
              {t.name}
            </option>
          ))}
        </select>
        <Button variant="secondary" disabled={busy || !resourceId || target?.canWrite === false} onClick={submit}>
          {busy ? 'Sending…' : exportInfo?.status === 'failed' ? 'Try again in Jira' : 'Create Jira issue'}
        </Button>
      </div>
      {target?.canWrite === false && <p className="text-xs text-amber-700">This Jira connection can only read. An administrator must enable issue creation (JIRA_ISSUE_CREATION and the write:jira-work permission) and connect Jira again.</p>}
      {error && <p className="text-sm text-red-700">{error.message}</p>}
    </div>
  );
}
