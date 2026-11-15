// Action Center: every action item WorkAgent found or was given — meetings, Teams, Jira, GitHub,
// Figma, Outlook — in one list, with views (mine, team, review, overdue, …), filters, bulk actions
// through the execution engine, and a link to each item's full evidence trail.
import { ListChecks, Play, Settings2, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { actionSummary, listActions } from '../../api/actions.js';
import { listPeople } from '../../api/directory.js';
import { listProjects } from '../../api/projects.js';
import { listTeams } from '../../api/teams.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ExecutePanel } from '../../components/actions/ExecutePanel.jsx';
import { CATEGORIES, LifecycleBadge, OWNER_KIND, PriorityIndicator, SOURCES } from '../../components/actions/labels.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { SourceIcon } from '../../components/icons.jsx';
import { Button, ButtonLink, ErrorAlert, FilterBar, FilterSelect, Loading, PageHeader, Person, SearchInput, Tabs, table } from '../../components/ui.jsx';
import { daysUntil, formatShortDate } from '../../utils/format.js';

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

  const anyFilter = Object.keys(filters).length > 0;
  const clearFilters = () => {
    const next = new URLSearchParams();
    if (params.get('view')) next.set('view', params.get('view'));
    setParams(next, { replace: true });
    setSelected(new Set());
  };
  const allSelected = data?.items.length > 0 && data.items.every((i) => selected.has(i.id));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Action Center"
        description="Commitments and next steps found in meetings, Teams, Jira, GitHub, Figma and e-mail — one item per commitment, each with the evidence behind it. Nothing is assigned, sent or created without a person’s approval."
        actions={
          <>
            <ButtonLink to="/approvals" icon={ShieldCheck}>
              Approvals
            </ButtonLink>
            {user.role === 'admin' && (
              <ButtonLink to="/actions/settings" icon={Settings2}>
                Settings
              </ButtonLink>
            )}
          </>
        }
      />

      <Tabs
        label="Views"
        value={view}
        onChange={(v) => set('view', v === 'all' ? '' : v)}
        items={VIEWS.filter(([v]) => v !== 'review' || summary?.canReview).map(([v, label]) => ({ value: v, label, count: summary?.counts?.[v] }))}
      />

      <FilterBar>
        <SearchInput
          key={filters.q ?? ''}
          className="w-full sm:w-64"
          aria-label="Search action items"
          placeholder="Search… (press Enter)"
          defaultValue={filters.q ?? ''}
          onKeyDown={(e) => e.key === 'Enter' && set('q', e.currentTarget.value.trim())}
        />
        <FilterSelect label="Project" value={filters.projectId ?? ''} onChange={(e) => set('projectId', e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </FilterSelect>
        <FilterSelect label="Team" value={filters.teamId ?? ''} onChange={(e) => set('teamId', e.target.value)}>
          <option value="">All teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </FilterSelect>
        {user.role !== 'employee' && (
          <FilterSelect label="Owner" value={filters.ownerId ?? ''} onChange={(e) => set('ownerId', e.target.value)}>
            <option value="">Any owner</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </FilterSelect>
        )}
        <FilterSelect label="Priority" className="capitalize" value={filters.priority ?? ''} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Any priority</option>
          {['high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
        </FilterSelect>
        <FilterSelect label="Source" value={filters.source ?? ''} onChange={(e) => set('source', e.target.value)}>
          <option value="">All sources</option>
          {Object.entries(SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </FilterSelect>
        <FilterSelect label="Category" value={filters.category ?? ''} onChange={(e) => set('category', e.target.value)}>
          <option value="">All categories</option>
          {Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </FilterSelect>
        {anyFilter && (
          <Button variant="ghost" icon={X} onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </FilterBar>

      <ErrorAlert error={error} />
      {selected.size > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-accent-200 bg-accent-50 px-4 py-2 text-sm text-slate-800 shadow-xs backdrop-blur">
          <span className="font-medium">
            {selected.size} selected{approvedSelected.length !== selected.size ? ` (${approvedSelected.length} approved can be acted on)` : ''}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button variant="link" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button icon={Play} disabled={!approvedSelected.length} onClick={() => setExecuting(true)}>
              Act on selected…
            </Button>
          </span>
        </div>
      )}
      {executing && <ExecutePanel itemIds={approvedSelected} onClose={() => setExecuting(false)} onDone={() => setReload((n) => n + 1)} />}

      {!data && !error && <Loading rows={6} />}
      {data && data.items.length === 0 && (
        <EmptyState title="Nothing here" icon={ListChecks}>
          {view === 'review' ? 'No action items are waiting for review.' : 'No action items match this view and these filters.'}
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className="w-9 py-2 pl-4 pr-1">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(data.items.map((i) => i.id)))}
                  />
                  <span className="sr-only">Select</span>
                </th>
                <th className={table.th}>Action</th>
                <th className={`${table.th} hidden lg:table-cell`}>Owner</th>
                <th className={table.th}>Due</th>
                <th className={`${table.th} hidden md:table-cell`}>Source</th>
                <th className={table.th}>State</th>
              </tr>
            </thead>
            <tbody className={table.body}>
              {data.items.map((i) => {
                const owner = i.assignee?.fullName ?? i.assigneeTeam?.name;
                const until = daysUntil(i.dueDate);
                return (
                  <tr key={i.id} className={`${table.row} ${selected.has(i.id) ? 'bg-accent-50' : ''}`}>
                    <td className="py-2.5 pl-4 pr-1 align-top">
                      <input type="checkbox" className="mt-0.5" aria-label={`Select ${i.title}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                    </td>
                    <td className={`${table.td} max-w-[28rem]`}>
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5">
                          <PriorityIndicator priority={i.priority} />
                        </span>
                        <div className="min-w-0">
                          <Link to={`/actions/${i.id}`} className="font-medium text-slate-900 hover:underline">
                            {i.title}
                          </Link>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {[i.categoryLabel, i.project?.name, i.priority === 'high' ? 'High priority' : null].filter(Boolean).join(' · ')}
                          </div>
                          <div className="mt-1 text-xs text-slate-500 lg:hidden">
                            {owner ?? <span className="text-amber-700">Unassigned</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={`${table.td} hidden lg:table-cell`}>
                      {owner ? <Person name={owner} detail={i.assigneeKind !== 'explicit' ? OWNER_KIND[i.assigneeKind] : null} /> : (
                        <>
                          <span className="text-amber-700">Unassigned</span>
                          {i.assigneeKind !== 'explicit' && i.assigneeKind !== 'unassigned' && <div className="text-xs text-slate-500">{OWNER_KIND[i.assigneeKind]}</div>}
                        </>
                      )}
                    </td>
                    <td className={`${table.td} whitespace-nowrap ${i.overdue ? 'font-medium text-red-700' : 'text-slate-700'}`}>
                      {i.dueDate ? (
                        <span title={i.dueDate}>
                          {formatShortDate(i.dueDate)}
                          {(i.overdue || (until !== null && until >= 0 && until <= 1)) && (
                            <span className={`block text-xs font-normal ${i.overdue ? 'text-red-700' : 'text-amber-700'}`}>{i.overdue ? `${Math.max(1, -until)} d late` : until === 0 ? 'Today' : 'Tomorrow'}</span>
                          )}
                        </span>
                      ) : i.dueDateRaw ? (
                        <span className="text-amber-700" title="Deadline needs clarification">“{i.dueDateRaw}”</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className={`${table.td} hidden text-xs text-slate-600 md:table-cell`}>
                      <span className="inline-flex items-center gap-1.5">
                        <SourceIcon source={i.source} size={14} />
                        {i.sourceLabel}
                      </span>
                      {i.meeting && <div className="max-w-[14rem] truncate text-slate-500">{i.meeting.title}</div>}
                    </td>
                    <td className={table.td}>
                      <LifecycleBadge state={i.lifecycle} />
                      {i.taskStatus === 'blocked' && <div className="mt-1 text-xs font-medium text-red-700">Blocked</div>}
                      {i.reviewStatus === 'pending' && typeof i.aiConfidence === 'number' && <div className="mt-1 text-xs text-slate-500">{Math.round(i.aiConfidence * 100)}% confidence</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.total > data.items.length && <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">Showing {data.items.length} of {data.total}. Narrow the filters to see the rest.</p>}
        </div>
      )}
    </div>
  );
}
