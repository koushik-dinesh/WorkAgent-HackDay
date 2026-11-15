// Shared labels for action items: lifecycle states, sources, categories, owner kinds.
// One restrained palette: neutral for in-review states, blue for in-flight, green for done,
// red only for failures, amber for "needs a person".
import { SignalHigh, SignalLow, SignalMedium } from 'lucide-react';
import { Badge } from '../ui.jsx';

export const LIFECYCLE = {
  extracted: { label: 'Extracted', tone: 'neutral' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  executing: { label: 'Executing', tone: 'info', pulse: true },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  retry_required: { label: 'Retry required', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'muted' },
};

export function LifecycleBadge({ state }) {
  const s = LIFECYCLE[state] ?? { label: state?.replaceAll('_', ' ') ?? '—', tone: 'neutral' };
  return (
    <Badge tone={s.tone} dot pulse={s.pulse} className={state === 'rejected' ? 'line-through' : ''}>
      {s.label}
    </Badge>
  );
}

const PRIORITY = {
  high: { label: 'High', Icon: SignalHigh, cls: 'text-red-700' },
  medium: { label: 'Medium', Icon: SignalMedium, cls: 'text-amber-700' },
  low: { label: 'Low', Icon: SignalLow, cls: 'text-slate-400' },
};

/** Priority as a signal-strength icon; `showLabel` adds the word next to it. */
export function PriorityIndicator({ priority, showLabel = false }) {
  const p = PRIORITY[priority];
  if (!p) return null;
  return (
    <span title={`${p.label} priority`} className={`inline-flex items-center gap-1 ${p.cls}`}>
      <p.Icon size={15} aria-hidden="true" />
      {showLabel ? <span className="text-slate-700">{p.label}</span> : <span className="sr-only">{p.label} priority</span>}
    </span>
  );
}

export const SOURCES = {
  meeting: 'Meeting transcript',
  teams_message: 'Microsoft Teams',
  jira_comment: 'Jira',
  github_comment: 'GitHub',
  figma_comment: 'Figma',
  outlook_email: 'Outlook',
  manual: 'Added manually',
  assistant: 'Assistant',
};

export const CATEGORIES = {
  task_assignment: 'Task assignment',
  follow_up: 'Follow-up',
  meeting_scheduling: 'Meeting scheduling',
  decision_implementation: 'Decision implementation',
  blocker_resolution: 'Blocker resolution',
  design_correction: 'Design correction',
  code_implementation: 'Code implementation',
  review_request: 'Review request',
  deadline_change: 'Deadline change',
  communication_required: 'Communication required',
};

export const OWNER_KIND = { explicit: 'Assigned explicitly', inferred: 'Inferred owner', team: 'Team owner', unassigned: 'Unassigned' };

export const EXECUTION_STATUS = {
  awaiting_approval: 'Awaiting approval',
  scheduled: 'Scheduled',
  executing: 'Executing',
  succeeded: 'Done (not verified)',
  verified: 'Done and verified',
  failed: 'Failed',
  retry_required: 'Retry required',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export const WORK_STATUS = {
  not_started: 'No linked activity yet',
  in_progress: 'In progress',
  implementation_complete: 'Linked work finished — confirm it',
  blocked: 'Blocked',
  done: 'Done',
};
