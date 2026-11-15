// Overview: "what needs my attention right now?" for the signed-in person.
// Every figure and list is read from the same endpoints the detail pages use (action summary,
// execution plans, insights, scheduled meetings, activity), so it shows only what the API lets this
// person see. Each section loads, fails and empties on its own; nothing here is a fixed number.
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, CircleDashed, ClipboardCheck, PlayCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { actionSummary, listActions, listPlans } from '../api/actions.js';
import { listScheduled } from '../api/features.js';
import { getInsights } from '../api/insights.js';
import { listActivities } from '../api/workRecords.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { LifecycleBadge, PriorityIndicator } from '../components/actions/labels.jsx';
import { SourceIcon } from '../components/icons.jsx';
import { ProviderBadge } from '../components/records.jsx';
import { Badge, ButtonLink, Card, Meter, MoreLink, PageHeader, Skeleton, StatCard, UserAvatar } from '../components/ui.jsx';
import { daysUntil, formatDateTime, formatShortDate, timeAgo } from '../utils/format.js';

const PERIOD_DAYS = 30;

/** Loads one section: { data, error, loading }. A failure affects only that section. */
function useSection(load, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    load()
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error) => live && setState({ data: null, error, loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Rows({ n = 4 }) {
  return (
    <div className="space-y-2.5 p-5" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  );
}

/** A card whose body is a list; handles its own loading, error and empty states. */
function ListCard({ title, section, more, empty, emptyIcon: EmptyIcon = CheckCircle2, children, className = '' }) {
  return (
    <Card title={title} actions={more} padded={false} className={className}>
      {section.loading && <Rows />}
      {section.error && <p className="px-5 py-6 text-sm text-slate-500">Couldn’t load this section: {section.error.message}</p>}
      {!section.loading && !section.error && (children ?? (
        <div className="flex items-center gap-2.5 px-5 py-6 text-sm text-slate-500">
          <EmptyIcon size={16} aria-hidden="true" className="text-slate-400" />
          {empty}
        </div>
      ))}
    </Card>
  );
}

function DueLabel({ date, overdue }) {
  if (!date) return <span className="text-slate-400">No date</span>;
  const d = daysUntil(date);
  const text = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : d < 0 ? `${-d} d late` : formatShortDate(date);
  return <span className={overdue || d < 0 ? 'font-medium text-red-700' : d <= 1 ? 'text-amber-700' : 'text-slate-500'}>{text}</span>;
}

export function OverviewPage() {
  const { user } = useAuth();
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - PERIOD_DAYS * 86_400_000).toISOString(), to: to.toISOString() };
  }, []);

  const summary = useSection(() => actionSummary());
  const insights = useSection(() => getInsights(range), [range]);
  const plans = useSection(() => listPlans({ status: 'awaiting_approval' }));
  const canReview = summary.data?.canReview;
  const focusView = canReview ? 'review' : 'mine';
  const focus = useSection(() => (summary.loading ? new Promise(() => {}) : listActions({ view: focusView, limit: 6 })), [summary.loading, focusView]);
  const meetings = useSection(() => listScheduled('mine'));
  const activity = useSection(() => listActivities({ limit: 8 }));

  const counts = summary.data?.counts ?? {};
  const totals = insights.data?.totals;
  const awaiting = plans.data?.plans ?? [];
  const upcoming = useMemo(() => {
    const now = Date.now();
    return (meetings.data?.meetings ?? [])
      .filter((m) => m.status !== 'cancelled' && new Date(m.startAt).getTime() >= now - 3_600_000)
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
      .slice(0, 5);
  }, [meetings.data]);
  const workload = useMemo(() => [...(insights.data?.workload ?? [])].sort((a, b) => b.open - a.open).slice(0, 6), [insights.data]);
  const maxOpen = Math.max(1, ...workload.map((w) => w.open));
  const figure = (section, value) => (section.loading ? <Skeleton className="h-7 w-10" /> : section.error ? '—' : value);

  const attention = (counts.overdue ?? 0) + (canReview ? (counts.review ?? 0) : 0) + awaiting.length;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting()}, ${user.fullName?.split(' ')[0] ?? 'there'}`}
        description={
          summary.loading || plans.loading
            ? today
            : attention > 0
              ? `${today} · ${attention} ${attention === 1 ? 'item needs' : 'items need'} your attention.`
              : `${today} · Nothing is waiting on you.`
        }
        actions={
          <>
            <ButtonLink to="/assistant" icon={Sparkles}>
              Ask the assistant
            </ButtonLink>
            <ButtonLink to="/actions" variant="primary" icon={ArrowRight}>
              Open Action Center
            </ButtonLink>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="What needs attention">
        {canReview ? (
          <StatCard label="Pending review" icon={ClipboardCheck} to="/actions?view=review" value={figure(summary, counts.review ?? 0)} tone={counts.review ? 'warning' : 'neutral'} hint="Extracted items to confirm" />
        ) : (
          <StatCard label="Assigned to me" icon={ClipboardCheck} to="/actions?view=mine" value={figure(summary, counts.mine ?? 0)} hint="Open action items" />
        )}
        <StatCard label="Overdue" icon={AlertTriangle} to="/actions?view=overdue" value={figure(summary, counts.overdue ?? 0)} tone={counts.overdue ? 'danger' : 'neutral'} hint="Past their due date" />
        <StatCard label="Awaiting approval" icon={ShieldCheck} to="/approvals" value={figure(plans, awaiting.length)} tone={awaiting.length ? 'accent' : 'neutral'} hint="Writes to connected apps" />
        <StatCard label="Completed" icon={CheckCircle2} to="/actions?view=completed" value={figure(insights, totals?.completedTasks ?? 0)} tone="success" hint={`In the last ${PERIOD_DAYS} days`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <ListCard
            title={canReview ? 'Waiting for your review' : 'Your action items'}
            section={focus}
            more={<MoreLink to={`/actions?view=${focusView}`}>View all</MoreLink>}
            empty={canReview ? 'No action items are waiting for review.' : 'Nothing is assigned to you right now.'}
          >
            {focus.data?.items?.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {focus.data.items.map((i) => (
                  <li key={i.id}>
                    <Link to={`/actions/${i.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors duration-150 hover:bg-slate-50">
                      <SourceIcon source={i.source} size={15} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{i.title}</span>
                        <span className="block truncate text-xs text-slate-500">{[i.sourceLabel, i.project?.name, i.assignee?.fullName ?? i.assigneeTeam?.name ?? 'Unassigned'].filter(Boolean).join(' · ')}</span>
                      </span>
                      <PriorityIndicator priority={i.priority} />
                      <span className="hidden w-20 text-right text-xs sm:block">
                        <DueLabel date={i.dueDate} overdue={i.overdue} />
                      </span>
                      <span className="hidden md:block">
                        <LifecycleBadge state={i.lifecycle} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ListCard>

          <ListCard title="Approvals waiting" section={plans} more={<MoreLink to="/approvals">Open approvals</MoreLink>} empty="No writes are waiting for approval.">
            {awaiting.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {awaiting.slice(0, 5).map((p) => (
                  <li key={p.id}>
                    <Link to={`/approvals?plan=${p.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors duration-150 hover:bg-slate-50">
                      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-50 text-accent-700">
                        <PlayCircle size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{p.title}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {[p.preview?.providerLabel, `${p.executions.length} write${p.executions.length === 1 ? '' : 's'}`, `requested by ${p.requestedBy?.fullName ?? 'WorkAgent'}`].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">{timeAgo(p.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ListCard>

          <ListCard title="Overdue work" section={insights} more={<MoreLink to="/actions?view=overdue">View all</MoreLink>} empty="Nothing is overdue.">
            {insights.data?.overdue?.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {insights.data.overdue.slice(0, 5).map((o) => (
                  <li key={o.task.id} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="min-w-0 flex-1">
                      <Link to={`/actions/${o.task.id}`} className="block truncate text-sm font-medium text-slate-900 hover:underline">
                        {o.task.title}
                      </Link>
                      <span className="block truncate text-xs text-slate-500">
                        {o.assignee?.name ?? 'Unassigned'} · due {formatShortDate(o.dueDate)}
                      </span>
                    </span>
                    <Badge tone="danger">{o.daysOverdue} d late</Badge>
                  </li>
                ))}
              </ul>
            )}
          </ListCard>

          <ListCard title="Recent activity" section={activity} more={<MoreLink to="/activity">All activity</MoreLink>} empty="Nothing has happened in your projects yet." emptyIcon={CircleDashed}>
            {activity.data?.activities?.length > 0 && (
              <ol className="divide-y divide-slate-100" aria-label="Recent activity">
                {activity.data.activities.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-2.5 text-sm">
                    <span className="mt-0.5">
                      <ProviderBadge provider={a.provider} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-slate-800">{a.summary}</span>
                      {a.project && <span className="block text-xs text-slate-500">in {a.project.name}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500" title={formatDateTime(a.occurredAt)}>
                      {timeAgo(a.occurredAt)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </ListCard>
        </div>

        <div className="space-y-6">
          <ListCard title="Highlights" section={insights} more={<MoreLink to="/insights">Insights</MoreLink>} empty="No highlights for this period.">
            {insights.data?.highlights?.length > 0 && (
              <ul className="space-y-3 p-5" aria-label="Highlights">
                {insights.data.highlights.slice(0, 5).map((h) => (
                  <li key={h.text} className="flex items-start gap-2.5 text-sm">
                    <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${h.kind === 'inference' ? 'bg-violet-500' : 'bg-slate-400'}`} />
                    <span className="min-w-0 text-slate-700">
                      {h.text}
                      {h.kind === 'inference' && (
                        <span title={h.rule ? `Rule: ${h.rule}` : undefined} className="ml-1.5 whitespace-nowrap text-xs text-violet-700">
                          Inference
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ListCard>

          <ListCard
            title="Upcoming meetings"
            section={meetings}
            more={<MoreLink to="/meetings/scheduled">Scheduling</MoreLink>}
            empty="No meetings scheduled through WorkAgent."
            emptyIcon={CalendarClock}
          >
            {upcoming.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {upcoming.map((m) => {
                  const start = new Date(m.startAt);
                  return (
                    <li key={m.meetingId}>
                      <Link to={`/meetings/scheduled/${m.meetingId}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors duration-150 hover:bg-slate-50">
                        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-md border border-slate-200 bg-white leading-none">
                          <span className="text-[9px] font-medium uppercase text-slate-500">{start.toLocaleDateString(undefined, { month: 'short' })}</span>
                          <span className="text-sm font-semibold text-slate-900">{start.getDate()}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-900">{m.title}</span>
                          <span className="block truncate text-xs text-slate-500">
                            {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {m.recipientCount} invited
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </ListCard>

          <ListCard title="Team workload" section={insights} more={<MoreLink to="/insights">Details</MoreLink>} empty="No assigned tasks in view.">
            {workload.length > 0 && (
              <ul className="space-y-3.5 p-5">
                {workload.map((w) => (
                  <li key={w.user.id}>
                    <div className="flex items-center gap-2 text-sm">
                      <UserAvatar name={w.user.name} size={20} />
                      <span className="min-w-0 flex-1 truncate text-slate-800">{w.user.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">
                        {w.open} open{w.overdue > 0 && <span className="text-red-700"> · {w.overdue} overdue</span>}
                      </span>
                    </div>
                    <Meter className="mt-1.5" value={w.open} max={maxOpen} tone={w.overdue ? 'danger' : 'accent'} label={`${w.user.name}: ${w.open} open tasks`} />
                  </li>
                ))}
              </ul>
            )}
          </ListCard>
        </div>
      </div>
    </div>
  );
}
