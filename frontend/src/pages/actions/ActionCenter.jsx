// Action Center: every action item WorkAgent found or was given — meetings, Teams, Jira, GitHub,
// Figma, Outlook — in one list, with views (mine, team, review, overdue, …), filters, bulk actions
// through the execution engine, and a link to each item's full evidence trail.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { actionSummary, listActions } from '../../api/actions.js';
import { listPeople } from '../../api/directory.js';
import { listProjects } from '../../api/projects.js';
import { listTeams } from '../../api/teams.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ExecutePanel } from '../../components/actions/ExecutePanel.jsx';
import { CATEGORIES, LifecycleBadge, OWNER_KIND, SOURCES } from '../../components/actions/labels.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, ErrorAlert, Loading, inputClass } from '../../components/ui.jsx';

export const VIEWS = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['team', 'My teams'],
  ['review', 'Pending review'],
  ['overdue', 'Overdue'],
  ['upcoming', 'Due in 7 days'],
  ['blocked', 'Blocked'],
  ['unassigned', 'Unassigned'],
  ['awaiting_execution', 'Awaiting execution'],
  ['completed', 'Completed'],
];
const FILTERS = ['projectId', 'teamId', 'ownerId', 'priority', 'source', 'category', 'q'];

export function ActionCenterPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'all';
  const filters = useMemo(() => Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? '']).filter(([, v]) => v)), [params]);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [projects, setProjects] = useState([]);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    listProjects().then((d) => setProjects(d.projects ?? [])).catch(() => {});
    listTeams().then((d) => setTeams(d.teams ?? [])).catch(() => {});
    if (user.role !== 'employee') listPeople().then((d) => setPeople(d.users ?? [])).catch(() => {});
  }, [user.role]);
  useEffect(() => {
    setData(null);
    setError(null);
    listActions({ view, ...filters, limit: 100 }).then(setData).catch(setError);
    actionSummary().then(setSummary).catch(() => {});
  }, [view, filters, reload]);

  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected(new Set());
  };
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const approvedSelected = data?.items.filter((i) => selected.has(i.id) && i.reviewStatus === 'approved').map((i) => i.id) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Action Center</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Commitments and next steps found in meetings, Teams, Jira, GitHub, Figma and e-mail — one item per commitment, each with the evidence behind it. Nothing is assigned, sent or created without a person’s approval.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/approvals" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
            Approvals
          </Link>
          {user.role === 'admin' && (
            <Link to="/actions/settings" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Settings
            </Link>
          )}
        </div>
      </div>

      <nav aria-label="Views" className="flex flex-wrap gap-1 border-b border-slate-200 pb-2">
        {VIEWS.filter(([v]) => v !== 'review' || summary?.canReview).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-current={view === v ? 'page' : undefined}
            onClick={() => set('view', v === 'all' ? '' : v)}
            className={`rounded-md px-3 py-1.5 text-sm ${view === v ? 'bg-slate-900 font-medium text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {label}
            {summary?.counts?.[v] !== undefined && <span className={`ml-1.5 text-xs ${view === v ? 'text-slate-300' : 'text-slate-400'}`}>{summary.counts[v]}</span>}
          </button>
        ))}
      </nav>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <input aria-label="Search action items" placeholder="Search…" className={inputClass} defaultValue={filters.q ?? ''} onKeyDown={(e) => e.key === 'Enter' && set('q', e.currentTarget.value.trim())} />
        <select aria-label="Project" className={inputClass} value={filters.projectId ?? ''} onChange={(e) => set('projectId', e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Team" className={inputClass} value={filters.teamId ?? ''} onChange={(e) => set('teamId', e.target.value)}>
          <option value="">All teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {user.role !== 'employee' ? (
          <select aria-label="Owner" className={inputClass} value={filters.ownerId ?? ''} onChange={(e) => set('ownerId', e.target.value)}>
            <option value="">Any owner</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        ) : (
          <span />
        )}
        <select aria-label="Priority" className={inputClass} value={filters.priority ?? ''} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Any priority</option>
          {['high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Source" className={inputClass} value={filters.source ?? ''} onChange={(e) => set('source', e.target.value)}>
          <option value="">All sources</option>
          {Object.entries(SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select aria-label="Category" className={inputClass} value={filters.category ?? ''} onChange={(e) => set('category', e.target.value)}>
          <option value="">All categories</option>
          {Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      <ErrorAlert error={error} />
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-sm">
          <span>
            {selected.size} selected{approvedSelected.length !== selected.size ? ` (${approvedSelected.length} approved can be acted on)` : ''}
          </span>
          <Button disabled={!approvedSelected.length} onClick={() => setExecuting(true)}>
            Act on selected…
          </Button>
          <Button variant="link" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {executing && <ExecutePanel itemIds={approvedSelected} onClose={() => setExecuting(false)} onDone={() => setReload((n) => n + 1)} />}

      {!data && !error && <Loading />}
      {data && data.items.length === 0 && (
        <EmptyState title="Nothing here">
          {view === 'review' ? 'No action items are waiting for review.' : 'No action items match this view and these filters.'}
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((i) => (
                <tr key={i.id} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Select ${i.title}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                  </td>
                  <td className="px-3 py-2">
                    <Link to={`/actions/${i.id}`} className="font-medium text-slate-900 hover:underline">
                      {i.title}
                    </Link>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {[i.categoryLabel, i.project?.name, i.priority === 'high' ? 'High priority' : null].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {i.assignee?.fullName ?? i.assigneeTeam?.name ?? <span className="text-amber-700">Unassigned</span>}
                    {i.assigneeKind !== 'explicit' && <div className="text-xs text-slate-500">{OWNER_KIND[i.assigneeKind]}</div>}
                  </td>
                  <td className={`whitespace-nowrap px-3 py-2 ${i.overdue ? 'font-medium text-red-700' : ''}`}>
                    {i.dueDate ?? (i.dueDateRaw ? <span className="text-amber-700" title="Deadline needs clarification">“{i.dueDateRaw}”</span> : '—')}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {i.sourceLabel}
                    {i.meeting && <div className="truncate text-slate-500">{i.meeting.title}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <LifecycleBadge state={i.lifecycle} />
                    {i.taskStatus === 'blocked' && <div className="mt-1 text-xs text-red-700">Blocked</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.items.length && <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500">Showing {data.items.length} of {data.total}. Narrow the filters to see the rest.</p>}
        </div>
      )}
    </div>
  );
}
