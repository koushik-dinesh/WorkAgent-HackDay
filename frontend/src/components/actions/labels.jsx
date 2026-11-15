// Shared labels for action items: lifecycle states, sources, categories, owner kinds.
// One restrained palette: neutral for in-review states, blue for in-flight, green for done,
// red only for failures, amber for "needs a person".
export const LIFECYCLE = {
  extracted: { label: 'Extracted', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' },
  needs_review: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  approved: { label: 'Approved', cls: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200' },
  scheduled: { label: 'Scheduled', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  executing: { label: 'Executing', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  completed: { label: 'Completed', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200' },
  retry_required: { label: 'Retry required', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200' },
  rejected: { label: 'Rejected', cls: 'bg-slate-100 text-slate-500 line-through dark:bg-slate-800 dark:text-slate-400' },
};

export function LifecycleBadge({ state }) {
  const s = LIFECYCLE[state] ?? { label: state?.replaceAll('_', ' ') ?? '—', cls: 'bg-slate-100 text-slate-700' };
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
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
