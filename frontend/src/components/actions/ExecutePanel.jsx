// "Do something with these action items": pick an action, fill its few options, see the exact
// preview (every target, recipient and message), approve, and cancel within the window.
// All writes go through the backend execution engine; this component never talks to a provider.
import { Ban, Eye, Play, TriangleAlert, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { approvePlan, cancelPlan, executionCapabilities, preparePlan } from '../../api/actions.js';
import { Button, Callout, ErrorAlert, Field, IconButton, inputClass } from '../ui.jsx';

const TEMPLATES = [
  ['assignment', 'Assignment (to each owner)'],
  ['reminder', 'Reminder (to each owner)'],
  ['overdue_escalation', 'Overdue escalation (to the manager)'],
  ['blocker_escalation', 'Blocker escalation (to the manager)'],
  ['meeting_summary', 'Meeting summary (to the participants)'],
];

function Options({ kind, caps, options, set }) {
  const targets = caps?.targets ?? [];
  if (['jira.create_issue', 'github.create_issue', 'teams.message'].includes(kind)) {
    return (
      <>
        <Field label={kind === 'teams.message' ? 'Channel' : kind === 'jira.create_issue' ? 'Jira project' : 'Repository'} hint="Leave on automatic to use the project’s mapped target">
          <select className={inputClass} value={options.resourceId ?? ''} onChange={(e) => set({ ...options, resourceId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Automatic</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.mock ? ' (development mock)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'teams.message' && (
          <Field label="Note (optional)">
            <input className={inputClass} value={options.note ?? ''} onChange={(e) => set({ ...options, note: e.target.value || undefined })} />
          </Field>
        )}
      </>
    );
  }
  if (kind === 'email.send' || kind === 'workagent.notify') {
    return (
      <>
        <Field label="Message">
          <select className={inputClass} value={options.template ?? 'assignment'} onChange={(e) => set({ ...options, template: e.target.value })}>
            {TEMPLATES.filter(([k]) => kind === 'email.send' || ['assignment', 'reminder'].includes(k)).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <textarea rows={2} className={inputClass} value={options.note ?? ''} onChange={(e) => set({ ...options, note: e.target.value || undefined })} />
        </Field>
      </>
    );
  }
  if (kind === 'jira.comment' || kind === 'github.comment') {
    return (
      <Field label="Comment">
        <textarea rows={3} className={inputClass} value={options.text ?? ''} onChange={(e) => set({ ...options, text: e.target.value })} />
      </Field>
    );
  }
  if (kind === 'jira.update') {
    return (
      <>
        <Field label="Priority">
          <select className={inputClass} value={options.priority ?? ''} onChange={(e) => set({ ...options, priority: e.target.value || undefined })}>
            <option value="">Unchanged</option>
            {['low', 'medium', 'high'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Due date" hint="Empty = the action item’s confirmed due date">
          <input type="date" className={inputClass} value={options.dueDate ?? ''} onChange={(e) => set({ ...options, dueDate: e.target.value || undefined })} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={Boolean(options.syncAssignee)} onChange={(e) => set({ ...options, syncAssignee: e.target.checked || undefined })} /> Set the Jira assignee to the owner
        </label>
      </>
    );
  }
  if (kind === 'jira.transition') {
    return (
      <Field label="New Jira status">
        <input className={inputClass} placeholder="e.g. In Progress, Done" value={options.status ?? ''} onChange={(e) => set({ ...options, status: e.target.value })} />
      </Field>
    );
  }
  if (kind === 'jira.link') {
    return (
      <Field label="Link to Jira issue">
        <input className={inputClass} placeholder="PAY-42" value={options.toKey ?? ''} onChange={(e) => set({ ...options, toKey: e.target.value.toUpperCase() })} />
      </Field>
    );
  }
  if (kind === 'calendar.schedule') {
    return (
      <>
        <Field label="Title">
          <input className={inputClass} value={options.title ?? ''} onChange={(e) => set({ ...options, title: e.target.value })} />
        </Field>
        <Field label="Start">
          <input type="datetime-local" className={inputClass} value={options.startLocal ?? ''} onChange={(e) => set({ ...options, startLocal: e.target.value, startAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
        </Field>
        <Field label="Length (minutes)">
          <input type="number" min={5} className={inputClass} value={options.durationMinutes ?? 30} onChange={(e) => set({ ...options, durationMinutes: Number(e.target.value) })} />
        </Field>
        <p className="text-xs text-slate-500">The owners are invited; add people and groups on the Schedule page for larger meetings.</p>
      </>
    );
  }
  return null;
}

function Countdown({ until, onDone }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((new Date(until) - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const l = Math.max(0, Math.round((new Date(until) - Date.now()) / 1000));
      setLeft(l);
      if (l === 0) {
        clearInterval(t);
        onDone?.();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until, onDone]);
  return <span>{left}s</span>;
}

/** Preview of a prepared plan (also used on the Approvals page). */
export function PlanPreview({ preview }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        <span className="font-medium text-slate-900">{preview.summary}</span> · {preview.providerLabel} · {preview.affected.records} write{preview.affected.records === 1 ? '' : 's'}, {preview.affected.people} {preview.affected.people === 1 ? 'person' : 'people'}
      </p>
      {preview.recipients?.length > 0 && (
        <p className="flex items-start gap-1.5">
          <Users size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-400" />
          <span>
            <span className="text-slate-500">Recipients:</span> {preview.recipients.map((r) => `${r.name} <${r.email}>`).join(', ')}
          </span>
        </p>
      )}
      <ul className="space-y-2">
        {preview.drafts.map((d, n) => (
          <li key={n} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium text-slate-900">{d.title}</span>
              {d.target && <span className="text-xs text-slate-500">→ {d.target}</span>}
            </div>
            {d.skipped && <p className="mt-1 text-xs text-slate-500">Skipped: {d.skipped}</p>}
            {d.content && (
              <dl className="mt-2 grid gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-xs sm:grid-cols-[7rem_1fr]">
                {Object.entries(d.content)
                  .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="capitalize text-slate-500">{k.replace(/([A-Z])/g, ' $1')}</dt>
                      <dd className="whitespace-pre-wrap break-words text-slate-800">{Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.name ?? JSON.stringify(x) : x)).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                    </div>
                  ))}
              </dl>
            )}
            {d.warnings.map((w) => <p key={w} className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-800"><TriangleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" /><span>{w}</span></p>)}
            {d.blockers.map((b) => <p key={b} className="mt-1.5 flex items-start gap-1.5 text-xs text-red-700"><Ban size={12} aria-hidden="true" className="mt-0.5 shrink-0" /><span>{b}</span></p>)}
          </li>
        ))}
      </ul>
      {preview.warnings?.map((w) => <Callout key={w} tone="warning">{w}</Callout>)}
      {preview.blockers?.map((b) => <Callout key={b} tone="danger">{b}</Callout>)}
    </div>
  );
}

export function ExecutePanel({ itemIds, defaultKind = null, onDone = () => {}, onClose }) {
  const [caps, setCaps] = useState(null);
  const [kind, setKind] = useState(defaultKind);
  const [options, setOptions] = useState({});
  const [prepared, setPrepared] = useState(null);
  const [largeOk, setLargeOk] = useState(false);
  const [approved, setApproved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    executionCapabilities().then(setCaps).catch(setError);
  }, []);
  const kindCaps = caps?.kinds.find((k) => k.kind === kind);

  async function step(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const prepare = () =>
    step(async () => {
      const { startLocal, ...opts } = options;
      setPrepared(await preparePlan({ kind, actionItemIds: itemIds, options: opts }));
      setLargeOk(false);
    });
  const approve = () =>
    step(async () => {
      const r = await approvePlan(prepared.planId, prepared.previewHash, largeOk);
      setApproved(r);
      onDone(r);
    });
  const cancel = () =>
    step(async () => {
      await cancelPlan(prepared.planId);
      setApproved(null);
      setPrepared(null);
      onDone(null);
    });

  return (
    <section aria-label="Execute action" className="space-y-4 rounded-xl border border-accent-200 bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-50 text-accent-700">
            <Play size={15} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Act on {itemIds.length} action item{itemIds.length === 1 ? '' : 's'}</h3>
            <p className="mt-0.5 text-xs text-slate-500">You see exactly what will be written before anything happens. Writes use your own permissions in the target application.</p>
          </div>
        </div>
        {onClose && <IconButton icon={X} label="Close" className="-mr-1.5 -mt-1.5" onClick={onClose} />}
      </div>
      <ErrorAlert error={error} />
      {!approved && (
        <>
          <Field label="Action">
            <select
              className={inputClass}
              value={kind ?? ''}
              onChange={(e) => {
                setKind(e.target.value || null);
                setOptions({});
                setPrepared(null);
              }}
            >
              <option value="">Choose…</option>
              {caps?.kinds.map((k) => (
                <option key={k.kind} value={k.kind} disabled={!k.available}>
                  {k.label}
                  {k.available ? '' : ` — unavailable: ${k.problem}`}
                </option>
              ))}
            </select>
          </Field>
          {kind && <Options kind={kind} caps={kindCaps} options={options} set={(o) => { setOptions(o); setPrepared(null); }} />}
          {kind && (
            <Button variant="secondary" icon={Eye} disabled={busy} onClick={prepare}>
              Preview
            </Button>
          )}
        </>
      )}
      {prepared && !approved && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h4 className="text-xs font-medium uppercase tracking-wider text-slate-500">Exactly what will be written</h4>
          <PlanPreview preview={prepared.preview} />
          {prepared.preview.requiresLargeConfirmation && (
            <label className="flex items-center gap-2 text-sm text-red-800">
              <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm this bulk operation ({prepared.preview.affected.records} writes, {prepared.preview.affected.people} people).
            </label>
          )}
          <div className="flex gap-2">
            <Button disabled={busy || !prepared.planId || (prepared.preview.requiresLargeConfirmation && !largeOk)} onClick={approve}>
              Approve and execute
            </Button>
            {prepared.planId && (
              <Button variant="secondary" disabled={busy} onClick={cancel}>
                Discard
              </Button>
            )}
          </div>
          {!prepared.planId && <p className="text-sm text-slate-600">Nothing can be executed as shown; fix the blocked or skipped items first.</p>}
        </div>
      )}
      {approved && (
        <div role="status" className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5 text-sm text-emerald-900">
          <p>Approved. {approved.cancelUntil ? <>It runs after the cancel window (<Countdown until={approved.cancelUntil} />).</> : 'It is running now.'}</p>
          <div className="flex gap-3">
            {approved.cancelUntil && new Date(approved.cancelUntil) > new Date() && (
              <Button variant="secondary" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
            )}
            <Link className="self-center font-medium underline underline-offset-2" to={`/approvals?plan=${approved.plan.id}`}>
              Track it on the Approvals page
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
