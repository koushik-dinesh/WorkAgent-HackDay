import { useState } from 'react';
import { updateMyTaskStatus } from '../../api/tasks.js';
import { Badge, Button, ErrorAlert } from '../ui.jsx';

export const STATUS_LABEL = { todo: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Completed' };
const STATUS_TONE = { todo: 'neutral', in_progress: 'info', blocked: 'warning', done: 'success' };
export const PRIORITY_STYLE = { high: 'bg-rose-100 text-rose-700', medium: 'bg-slate-100 text-slate-700', low: 'bg-slate-100 text-slate-500' };

export function TaskStatusBadge({ status }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// Button label for moving from `from` to `to`.
function actionLabel(from, to) {
  if (to === 'done') return 'Mark complete';
  if (to === 'blocked') return 'Mark blocked';
  if (to === 'todo') return 'Mark not started';
  if (from === 'done') return 'Reopen';
  if (from === 'blocked') return 'Resume';
  return 'Start';
}
const ORDER = ['in_progress', 'done', 'blocked', 'todo'];

/**
 * Status buttons for the transitions the server allows (task.allowedStatuses). The new status
 * is shown only after the server confirms it; while a request runs all buttons are disabled.
 */
export function TaskStatusControl({ task, onUpdated, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function change(status) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { task: updated } = await updateMyTaskStatus(task.id, status, task.taskStatus);
      await onUpdated(updated);
    } catch (err) {
      setError(err.code === 'STALE_STATUS' ? `${err.message}` : err);
    } finally {
      setBusy(false);
    }
  }

  const options = ORDER.filter((s) => task.allowedStatuses?.includes(s));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Update status of ${task.title}`}>
        {options.map((s, i) => (
          <Button
            key={s}
            variant={i === 0 ? 'primary' : 'secondary'}
            size={compact ? 'sm' : 'md'}
            disabled={busy}
            onClick={() => change(s)}
          >
            {actionLabel(task.taskStatus, s)}
          </Button>
        ))}
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}
