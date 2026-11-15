// Structured-output contract for assistant commands (WorkAPI). The model may only choose one of a
// closed set of intents and fill slots with words the person actually said; it never decides what
// gets executed. Everything it returns is re-checked in code (parser.js): unknown intents become
// 'unsupported', slot text that is not in the utterance is dropped, dates are resolved
// deterministically where possible, and nothing is executed without a confirmation card.
export const INTENTS = ['create_meeting', 'assign_task', 'update_task', 'set_deadline', 'query_status', 'query_work', 'act_on_actions', 'unsupported'];
// query_work: read-only questions about the work graph (action items, commitments, blockers, progress).
export const WORK_QUERIES = ['action_items', 'overdue_commitments', 'project_blockers', 'promised_vs_progress', 'pending_owners', 'design_changes'];
// act_on_actions: a closed set of bulk operations, always executed through the execution engine
// after a full preview and confirmation.
export const OPERATIONS = ['create_jira_issues', 'email_owners', 'notify_owners', 'post_to_teams', 'send_meeting_summary', 'send_weekly_report'];
export const SELECTIONS = ['pending', 'approved', 'overdue', 'open', 'blocked'];
export const PRIORITIES = ['lowest', 'low', 'medium', 'high', 'critical'];
export const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
export const QUERIES = ['overdue_tasks', 'my_tasks', 'due_soon', 'blocked_tasks', 'task_status'];
export const PROVIDERS = ['outlook', 'google', 'workagent'];

const nstr = (description) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description });
const nenum = (values, description) => ({ anyOf: [{ type: 'string', enum: values }, { type: 'null' }], description });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const COMMAND_SCHEMA = object({
  intent: { type: 'string', enum: INTENTS, description: 'The one supported action the person asked for; "unsupported" for anything else' },
  slots: object({
    task_reference: nstr('Words identifying an EXISTING task or Jira issue to change or ask about, exactly as said (e.g. "the payment integration task", "PAY-42")'),
    task_title: nstr('Title for a NEW task, from the person’s words'),
    description: nstr('Extra details for a new task, only if said'),
    assignee: nstr('Person the task is assigned to, exactly as said (e.g. "Priya")'),
    project: nstr('Project, Jira project or team named for the task, exactly as said'),
    priority: nenum(PRIORITIES, 'Priority only if stated'),
    status: nenum(STATUSES, 'New status only if stated (update_task)'),
    due_date_text: nstr('Deadline words exactly as said (e.g. "next Friday", "by 20 November")'),
    due_date: nstr('That deadline as YYYY-MM-DD using the reference date, or null if unclear'),
    meeting_title: nstr('Meeting title or topic, from the person’s words (e.g. "design review")'),
    attendees: { type: 'array', items: { type: 'string' }, description: 'People, teams, departments or groups to invite, each exactly as said' },
    attendees_from_meeting: nstr('An earlier meeting whose attendees should be invited, exactly as said (e.g. "this morning’s standup")'),
    start_text: nstr('Meeting start words exactly as said (e.g. "Thursday at 4 PM")'),
    start_datetime: nstr('That start as local YYYY-MM-DDTHH:mm using the reference date and time zone, or null if unclear'),
    duration_minutes: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Meeting length in minutes only if stated' },
    calendar_provider: nenum(PROVIDERS, 'Only if the person named Outlook/Teams (outlook), Google/Meet (google) or WorkAgent'),
    query: nenum(QUERIES, 'For query_status: what is asked'),
    query_person: nstr('For query_status about someone else: the person exactly as said; null means the speaker'),
    work_query: nenum(WORK_QUERIES, 'For query_work: what is asked'),
    operation: nenum(OPERATIONS, 'For act_on_actions: the bulk operation asked for'),
    selection: nenum(SELECTIONS, 'Which action items, only if stated (pending = not yet done, approved, overdue, open, blocked)'),
    item_kind: nstr('Kind or area of action items exactly as said (e.g. "engineering", "design"), only if said'),
    meeting_reference: nstr('An earlier meeting the request is about, exactly as said (e.g. "yesterday’s meetings", "the design review")'),
    period_text: nstr('Time period words exactly as said (e.g. "yesterday", "this week"), only if said'),
    recipients: nstr('Who should receive it (people, team or group) exactly as said, only if said'),
  }),
  missing: { type: 'array', items: { type: 'string' }, description: 'Names of slots the action needs that the person did not state' },
  clarification_question: nstr('One short question asking for what is missing or unclear; null if nothing is'),
});
