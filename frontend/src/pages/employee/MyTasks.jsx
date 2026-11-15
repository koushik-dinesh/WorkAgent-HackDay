import { AlertTriangle, CalendarDays, CheckCircle2, CheckSquare, ChevronRight, Circle, CircleDot, ListTodo } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { listMyTasks } from '../../api/tasks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { PRIORITY_STYLE, STATUS_LABEL, TaskStatusBadge, TaskStatusControl } from '../../components/tasks/TaskStatus.jsx';
import { Callout, ErrorAlert, Loading, PageHeader, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDate } from '../../utils/format.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const SORTS = {
  due: { label: 'Due date (soonest)', fn: (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] },
  priority: { label: 'Priority (highest)', fn: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') },
  meeting: { label: 'Meeting (newest)', fn: (a, b) => String(b.meeting.scheduledAt ?? '').localeCompare(String(a.meeting.scheduledAt ?? '')) },
};
const SUMMARY_CARDS = [
  ['total', 'Total', ListTodo],
  ['todo', 'Not started', Circle],
  ['inProgress', 'In progress', CircleDot],
  ['done', 'Completed', CheckCircle2],
  ['overdue', 'Overdue', AlertTriangle],
];

export function MyTasks() {
  const { user } = useAuth();
  const [data, setData] = useState(null); // { tasks, summary, today }
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('due');

  const load = useCallback(
    () =>
      listMyTasks()
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch(setError),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    return data.tasks
      .filter((t) => (status === 'all' ? true : status === 'open' ? t.taskStatus !== 'done' : t.taskStatus === status))
      .filter((t) => !priority || t.priority === priority)
      .filter((t) => !overdueOnly || t.overdue)
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.meeting.title.toLowerCase().includes(needle))
      .sort(SORTS[sort].fn);
  }, [data, status, priority, overdueOnly, search, sort]);

  // After a status change, reload from the server so counts and overdue flags stay authoritative.
  async function handleUpdated(task) {
    setNotice(`“${task.title}” is now ${STATUS_LABEL[task.taskStatus].toLowerCase()}.`);
    await load();
  }

  // Under the default "due date" order the list reads as a plan: past due, today, upcoming, undated.
  const bucketOf = (t) => (!t.dueDate ? 'No due date' : t.dueDate < data.today ? 'Past due date' : t.dueDate === data.today ? 'Due today' : 'Upcoming');
  const filtered = status !== 'open' || priority || overdueOnly || search.trim();

  return (
    <div className="space-y-6">
      <PageHeader title="My tasks" description={`Signed in as ${user.email}`} />

      {error && !data && <ErrorAlert error={`Could not load your tasks: ${error.message}`} />}
      {!data && !error && <Loading label="Loading your tasks…" rows={5} />}

      {data && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {SUMMARY_CARDS.map(([key, label, Icon]) => {
              const alert = key === 'overdue' && data.summary.overdue;
              return (
                <div key={key} className={`rounded-xl border bg-white px-4 py-3 ${alert ? 'border-red-200' : 'border-slate-200'}`}>
                  <dt className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
                    {label}
                    <Icon size={14} aria-hidden="true" className={alert ? 'text-red-700' : 'text-slate-400'} />
                  </dt>
                  <dd className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-tight ${alert ? 'text-red-700' : 'text-slate-900'}`}>{data.summary[key]}</dd>
                </div>
              );
            })}
          </dl>
          {data.summary.blocked > 0 && <Callout tone="warning">{data.summary.blocked} task{data.summary.blocked === 1 ? ' is' : 's are'} blocked.</Callout>}

          {data.tasks.length === 0 ? (
            <EmptyState title="No tasks assigned" icon={CheckSquare}>Tasks approved from your meetings will appear here.</EmptyState>
          ) : (
            <>
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end">
                <label className="block text-[13px]">
                  <span className="font-medium text-slate-700">Search</span>
                  <input type="search" className={`${inputClass} mt-1.5`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Task or meeting title" />
                </label>
                <label className="block text-[13px]">
                  <span className="font-medium text-slate-700">Status</span>
                  <select className={`${inputClass} mt-1.5`} value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="open">Open (not completed)</option>
                    <option value="all">All</option>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[13px]">
                  <span className="font-medium text-slate-700">Priority</span>
                  <select className={`${inputClass} mt-1.5`} value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="">Any</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label className="block text-[13px]">
                  <span className="font-medium text-slate-700">Sort by</span>
                  <select className={`${inputClass} mt-1.5`} value={sort} onChange={(e) => setSort(e.target.value)}>
                    {Object.entries(SORTS).map(([v, s]) => (
                      <option key={v} value={v}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-700">
                  <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
                  Overdue only
                </label>
              </div>

              <SuccessAlert>{notice}</SuccessAlert>
              {error && <ErrorAlert error={`Could not refresh your tasks: ${error.message}`} />}

              {visible.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">No tasks match these filters.</p>
              ) : (
                <ul className="space-y-2.5" aria-label="Tasks">
                  {visible.map((t, n) => {
                    const bucket = sort === 'due' ? bucketOf(t) : null;
                    const heading = bucket && (n === 0 || bucketOf(visible[n - 1]) !== bucket) ? bucket : null;
                    return (
                      <li key={t.id}>
                        {heading && (
                          <h2 className={`mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500 ${n === 0 ? '' : 'mt-6'}`}>
                            {heading}
                            <span className="rounded-full bg-slate-100 px-1.5 text-[11px] tabular-nums">{visible.filter((x) => bucketOf(x) === bucket).length}</span>
                          </h2>
                        )}
                        <TaskCard task={t} onUpdated={handleUpdated} />
                      </li>
                    );
                  })}
                </ul>
              )}
              {filtered && visible.length > 0 && <p className="text-xs text-slate-500">Showing {visible.length} of {data.tasks.length} tasks.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, onUpdated }) {
  return (
    <article aria-label={task.title} className={`rounded-xl border bg-white px-4 py-3.5 transition-colors duration-150 sm:px-5 ${task.overdue ? 'border-red-200' : 'border-slate-200 hover:border-slate-300'}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-semibold text-slate-900">
            <Link to={`/my/tasks/${task.id}`} className="hover:underline">
              {task.title}
            </Link>
          </h2>
          <p className="mt-0.5 break-words text-[13px] text-slate-500">
            From “{task.meeting.title}”{task.project && <> · Project: {task.project.name}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <TaskStatusBadge status={task.taskStatus} />
          <span className={`rounded-full px-2 py-0.5 font-medium capitalize ${PRIORITY_STYLE[task.priority]}`}>{task.priority} priority</span>
        </div>
      </div>
      {task.description && <p className="mt-2 line-clamp-2 break-words text-sm text-slate-600">{task.description}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <p className="flex items-center gap-1.5 text-[13px]">
          <CalendarDays size={13} aria-hidden="true" className={task.overdue ? 'text-red-700' : 'text-slate-400'} />
          {task.dueDate ? (
            <span className={task.overdue ? 'font-medium text-red-700' : 'text-slate-700'}>
              Due {formatDate(task.dueDate)}
              {task.overdue && ' · Overdue'}
            </span>
          ) : (
            <span className="text-slate-500">No due date</span>
          )}
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <TaskStatusControl task={task} onUpdated={onUpdated} compact />
          <Link to={`/my/tasks/${task.id}`} className="inline-flex h-7 items-center gap-0.5 text-[13px] font-medium text-slate-600 hover:text-slate-900">
            Details
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </article>
  );
}
