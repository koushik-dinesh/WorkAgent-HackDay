// Approvals: every plan of external writes — waiting for approval, inside its cancel window,
// running, done, or failed — with the exact preview that was approved, each execution's external
// reference, retries, and the audit trail.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { approvePlan, cancelPlan, getPlan, listPlans, rejectPlan, retryExecution } from '../../api/actions.js';
import { PlanPreview } from '../../components/actions/ExecutePanel.jsx';
import { EXECUTION_STATUS } from '../../components/actions/labels.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const PLAN_STATUS = {
  awaiting_approval: { label: 'Awaiting approval', cls: 'bg-amber-100 text-amber-800' },
  scheduled: { label: 'Scheduled', cls: 'bg-sky-100 text-sky-800' },
  executing: { label: 'Executing', cls: 'bg-sky-100 text-sky-800' },
  completed: { label: 'Completed', cls: 'bg-emerald-100 text-emerald-800' },
  partially_failed: { label: 'Partly failed', cls: 'bg-red-100 text-red-700' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-600' },
  rejected: { label: 'Rejected', cls: 'bg-slate-100 text-slate-600' },
};
const TABS = [
  ['awaiting_approval', 'Awaiting approval'],
  ['scheduled,executing', 'In progress'],
  ['partially_failed,failed', 'Failed'],
  ['completed', 'Completed'],
  ['', 'All'],
];

function PlanBadge({ status }) {
  const s = PLAN_STATUS[status] ?? { label: status, cls: 'bg-slate-100' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
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
    <div className="space-y-4">
      <ErrorAlert error={error} />
      <p className="text-xs text-slate-500">
        Requested by {plan.requestedBy?.fullName ?? 'WorkAgent'} via {plan.origin.replace('_', ' ')} · {formatDateTime(plan.createdAt)}
        {plan.approvedBy ? ` · approved by ${plan.approvedBy.fullName}` : plan.approvalBasis === 'policy' ? ' · approved by organisation policy' : ''}
      </p>
      {plan.preview && <PlanPreview preview={plan.preview} />}
      {plan.status === 'awaiting_approval' && (
        <div className="space-y-2">
          {plan.preview?.requiresLargeConfirmation && (
            <label className="flex items-center gap-2 text-sm text-red-800">
              <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm this bulk operation.
            </label>
          )}
          <div className="flex gap-2">
            <Button disabled={plan.preview?.requiresLargeConfirmation && !largeOk} onClick={() => run(() => approvePlan(plan.id, plan.previewHash, largeOk))}>
              Approve and execute
            </Button>
            <Button variant="danger" onClick={() => run(() => rejectPlan(plan.id))}>
              Reject
            </Button>
          </div>
        </div>
      )}
      {inWindow && (
        <Button variant="secondary" onClick={() => run(() => cancelPlan(plan.id))}>
          Cancel before it runs
        </Button>
      )}
      {plan.executions.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Write</th>
              <th className="py-1">Status</th>
              <th className="py-1">Result</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {plan.executions.map((x) => (
              <tr key={x.id} className="align-top">
                <td className="py-2">
                  {x.kind}
                  {x.itemIds.length > 0 && (
                    <div className="text-xs">
                      {x.itemIds.map((iid) => (
                        <Link key={iid} className="mr-2 underline" to={`/actions/${iid}`}>
                          #{iid}
                        </Link>
                      ))}
                    </div>
                  )}
                </td>
                <td className="py-2">
                  {EXECUTION_STATUS[x.status] ?? x.status}
                  {x.attempts > 1 && <span className="text-xs text-slate-500"> · {x.attempts} attempts</span>}
                </td>
                <td className="py-2 text-xs">
                  {x.externalUrl ? (x.externalUrl.startsWith('/') ? <Link className="underline" to={x.externalUrl}>{x.externalKey}</Link> : <a className="underline" href={x.externalUrl} target="_blank" rel="noreferrer">{x.externalKey}</a>) : x.externalKey}
                  {x.lastError && <div className="text-red-700">{x.lastError}</div>}
                </td>
                <td className="py-2 text-right">
                  {['failed', 'retry_required'].includes(x.status) && (
                    <Button variant="secondary" onClick={() => run(() => retryExecution(x.id))}>
                      Retry
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details>
        <summary className="cursor-pointer text-sm">Audit trail ({plan.history.length})</summary>
        <ol className="mt-2 space-y-1 text-xs">
          {plan.history.map((h, n) => (
            <li key={n}>
              {formatDateTime(h.at)} · {h.action} · {h.actor}
              {h.detail?.error ? ` · ${h.detail.error}` : ''}
              {h.detail?.externalKey ? ` · ${h.detail.externalKey}` : ''}
            </li>
          ))}
        </ol>
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
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="mt-1 text-sm text-slate-500">Every write WorkAgent makes in Jira, e-mail, Teams, GitHub or calendars is listed here with what was approved, by whom, and what the application confirmed.</p>
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-slate-200 pb-2" aria-label="Plan status">
        {TABS.map(([v, l]) => (
          <button key={l} type="button" aria-current={status === v ? 'page' : undefined} onClick={() => set('status', v || 'all')} className={`rounded-md px-3 py-1.5 text-sm ${status === v || (v === '' && status === 'all') ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            {l}
          </button>
        ))}
      </nav>
      <ErrorAlert error={error} />
      {!plans && !error && <Loading />}
      {plans?.length === 0 && <EmptyState title="Nothing here">No plans in this state.</EmptyState>}
      <div className="space-y-3">
        {plans?.map((p) => (
          <Card
            key={p.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <button type="button" className="text-left hover:underline" onClick={() => set('plan', String(open) === String(p.id) ? '' : String(p.id))}>
                  {p.title}
                </button>
                <PlanBadge status={p.status} />
              </span>
            }
            actions={<span className="text-xs text-slate-500">#{p.id} · {formatDateTime(p.createdAt)}</span>}
          >
            {String(open) === String(p.id) ? (
              <PlanDetail id={p.id} onChanged={() => setN((x) => x + 1)} />
            ) : (
              <p className="text-sm text-slate-600">
                {p.executions.length} write{p.executions.length === 1 ? '' : 's'} · {p.preview?.providerLabel} · {p.requestedBy?.fullName ?? 'WorkAgent'}{' '}
                <button type="button" className="ml-2 text-xs underline" onClick={() => set('plan', String(p.id))}>
                  Details
                </button>
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
