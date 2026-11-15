// Approvals: every plan of external writes — waiting for approval, inside its cancel window,
// running, done, or failed — with the exact preview that was approved, each execution's external
// reference, retries, and the audit trail.
import { ChevronDown, Clock, ExternalLink, RotateCcw, ShieldCheck, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { approvePlan, cancelPlan, getPlan, listPlans, rejectPlan, retryExecution } from '../../api/actions.js';
import { PlanPreview } from '../../components/actions/ExecutePanel.jsx';
import { EXECUTION_STATUS } from '../../components/actions/labels.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { IntegrationIcon } from '../../components/icons.jsx';
import { ActivityTimeline, Badge, Button, Callout, ErrorAlert, Loading, PageHeader, Tabs, table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const PLAN_STATUS = {
  awaiting_approval: { label: 'Awaiting approval', tone: 'warning' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  executing: { label: 'Executing', tone: 'info', pulse: true },
  completed: { label: 'Completed', tone: 'success' },
  partially_failed: { label: 'Partly failed', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  rejected: { label: 'Rejected', tone: 'muted' },
};
const TABS = [
  ['awaiting_approval', 'Awaiting approval'],
  ['scheduled,executing', 'In progress'],
  ['partially_failed,failed', 'Failed'],
  ['completed', 'Completed'],
  ['', 'All'],
];
const EXECUTION_TONE = { awaiting_approval: 'warning', scheduled: 'info', executing: 'info', succeeded: 'success', verified: 'success', failed: 'danger', retry_required: 'danger', cancelled: 'muted', rejected: 'muted' };
// Which application a plan writes to, from the kind of its first write ("jira.create_issue" -> jira).
const KIND_PROVIDER = { jira: 'jira', github: 'github', teams: 'microsoft_teams', email: 'outlook', calendar: 'google_calendar', workagent: 'workagent' };
const providerOf = (plan) => plan.preview?.provider ?? KIND_PROVIDER[plan.executions?.[0]?.kind?.split('.')[0]] ?? 'workagent';
const linkClass = 'font-medium text-accent-700 underline-offset-2 hover:underline';

function PlanBadge({ status }) {
  const s = PLAN_STATUS[status] ?? { label: status, tone: 'neutral' };
  return (
    <Badge tone={s.tone} dot pulse={s.pulse}>
      {s.label}
    </Badge>
  );
}

function PlanDetail({ id, onChanged }) {
  const [plan, setPlan] = useState(null);
  const [largeOk, setLargeOk] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => getPlan(id).then((d) => setPlan(d.plan)).catch(setError), [id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!plan) return error ? <ErrorAlert error={error} /> : <Loading />;
  const run = async (fn) => {
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(err);
    }
  };
  const inWindow = plan.status === 'scheduled' && plan.cancelUntil && new Date(plan.cancelUntil) > new Date();
  return (
    <div className="space-y-5">
      <ErrorAlert error={error} />
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
        <UserRound size={12} aria-hidden="true" />
        Requested by {plan.requestedBy?.fullName ?? 'WorkAgent'} via {plan.origin.replace('_', ' ')} · {formatDateTime(plan.createdAt)}
        {plan.approvedBy ? ` · approved by ${plan.approvedBy.fullName}` : plan.approvalBasis === 'policy' ? ' · approved by organisation policy' : ''}
      </p>
      {plan.preview && (
        <section aria-label="Execution preview" className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Exactly what will be written</h3>
          <PlanPreview preview={plan.preview} />
        </section>
      )}
      {plan.status === 'awaiting_approval' && (
        <div className="space-y-3">
          <Callout tone="neutral">
            Approving runs these writes with the requester’s own permissions in the target application.
            {plan.preview?.cancelSeconds ? ` You can cancel for ${plan.preview.cancelSeconds} seconds after approving.` : ''}
          </Callout>
          {plan.preview?.requiresLargeConfirmation && (
            <label className="flex items-center gap-2 text-sm text-red-800">
              <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm this bulk operation.
            </label>
          )}
          <div className="flex gap-2">
            <Button icon={ShieldCheck} disabled={plan.preview?.requiresLargeConfirmation && !largeOk} onClick={() => run(() => approvePlan(plan.id, plan.previewHash, largeOk))}>
              Approve and execute
            </Button>
            <Button variant="danger" onClick={() => run(() => rejectPlan(plan.id))}>
              Reject
            </Button>
          </div>
        </div>
      )}
      {inWindow && (
        <Callout tone="info">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={13} aria-hidden="true" />
              Approved. It runs at {new Date(plan.cancelUntil).toLocaleTimeString()} unless cancelled.
            </span>
            <Button variant="secondary" size="sm" onClick={() => run(() => cancelPlan(plan.id))}>
              Cancel before it runs
            </Button>
          </div>
        </Callout>
      )}
      {plan.executions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Write</th>
                <th className={table.th}>Status</th>
                <th className={table.th}>Result</th>
                <th className={table.th} />
              </tr>
            </thead>
            <tbody className={table.body}>
              {plan.executions.map((x) => (
                <tr key={x.id}>
                  <td className={table.td}>
                    <code>{x.kind}</code>
                    {x.itemIds.length > 0 && (
                      <div className="mt-1 text-xs">
                        {x.itemIds.map((iid) => (
                          <Link key={iid} className={`mr-2 ${linkClass}`} to={`/actions/${iid}`}>
                            #{iid}
                          </Link>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={table.td}>
                    <Badge tone={EXECUTION_TONE[x.status] ?? 'neutral'}>{EXECUTION_STATUS[x.status] ?? x.status}</Badge>
                    {x.attempts > 1 && <span className="text-xs text-slate-500"> · {x.attempts} attempts</span>}
                  </td>
                  <td className={`${table.td} text-xs`}>
                    {x.externalUrl ? (x.externalUrl.startsWith('/') ? <Link className={linkClass} to={x.externalUrl}>{x.externalKey}</Link> : <a className={`inline-flex items-center gap-1 ${linkClass}`} href={x.externalUrl} target="_blank" rel="noreferrer">{x.externalKey}<ExternalLink size={11} aria-hidden="true" /></a>) : x.externalKey}
                    {x.lastError && <div className="text-red-700">{x.lastError}</div>}
                  </td>
                  <td className={`${table.td} text-right`}>
                    {['failed', 'retry_required'].includes(x.status) && (
                      <Button variant="secondary" size="sm" icon={RotateCcw} onClick={() => run(() => retryExecution(x.id))}>
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <ChevronDown size={14} aria-hidden="true" className="-rotate-90 transition-transform duration-150 group-open:rotate-0" />
          Audit trail ({plan.history.length})
        </summary>
        <div className="mt-3 pl-1">
          <ActivityTimeline
            items={plan.history.map((h, n) => ({
              key: n,
              title: <span className="font-medium">{h.action}</span>,
              detail: `· ${h.actor}${h.detail?.error ? ` · ${h.detail.error}` : ''}${h.detail?.externalKey ? ` · ${h.detail.externalKey}` : ''}`,
              at: formatDateTime(h.at),
              tone: /fail|reject/.test(h.action) ? 'danger' : /approv|verified|succeed|complet/.test(h.action) ? 'success' : 'neutral',
            }))}
          />
        </div>
      </details>
    </div>
  );
}

export function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'awaiting_approval';
  const open = params.get('plan');
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    setPlans(null);
    // A linked plan (?plan=) is found whatever its state; 'all' lists every state.
    listPlans((open && !params.get('status')) || status === 'all' ? {} : { status }).then((d) => setPlans(d.plans)).catch(setError);
  }, [status, open, n, params]);
  const set = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals"
        description="Every write WorkAgent makes in Jira, e-mail, Teams, GitHub or calendars is listed here with what was approved, by whom, and what the application confirmed."
      />
      <Tabs label="Plan status" value={status === 'all' ? '' : status} onChange={(v) => set('status', v || 'all')} items={TABS.map(([value, label]) => ({ value, label }))} />
      <ErrorAlert error={error} />
      {!plans && !error && <Loading />}
      {plans?.length === 0 && <EmptyState title="Nothing here" icon={ShieldCheck}>No plans in this state.</EmptyState>}
      <ul className="space-y-3">
        {plans?.map((p) => {
          const isOpen = String(open) === String(p.id);
          const provider = providerOf(p);
          return (
            <li key={p.id} className={`rounded-xl border bg-white transition-colors duration-150 ${isOpen ? 'border-slate-300' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <IntegrationIcon provider={provider} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" aria-expanded={isOpen} className="text-left text-sm font-semibold text-slate-900 hover:underline" onClick={() => set('plan', isOpen ? '' : String(p.id))}>
                      {p.title}
                    </button>
                    <PlanBadge status={p.status} />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {p.executions.length} write{p.executions.length === 1 ? '' : 's'} · {p.preview?.providerLabel} · {p.requestedBy?.fullName ?? 'WorkAgent'}
                  </p>
                </div>
                <span className="text-xs text-slate-500">#{p.id} · {formatDateTime(p.createdAt)}</span>
                {!isOpen && (
                  <Button variant="secondary" size="sm" onClick={() => set('plan', String(p.id))}>
                    Details
                  </Button>
                )}
              </div>
              {isOpen && (
                <div className="border-t border-slate-200 px-5 py-4">
                  <PlanDetail id={p.id} onChanged={() => setN((x) => x + 1)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
