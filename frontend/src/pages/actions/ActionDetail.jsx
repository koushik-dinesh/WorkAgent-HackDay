// One action item with its complete evidence trail: where it was said or written (transcript
// line, Teams message, Jira/GitHub/Figma comment), supporting evidence from other sources, the
// real state of the linked work, every execution in connected applications, and the audit history.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { editAction, getAction, retryExecution, reviewAction, setActionStatus } from '../../api/actions.js';
import { listPeople } from '../../api/directory.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ExecutePanel } from '../../components/actions/ExecutePanel.jsx';
import { CATEGORIES, EXECUTION_STATUS, LifecycleBadge, OWNER_KIND, WORK_STATUS } from '../../components/actions/labels.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime, formatTimestamp } from '../../utils/format.js';

const RELATION = { origin: 'Where it was agreed', supporting: 'Also mentioned', progress: 'Progress', completion: 'Completion evidence' };
const PROVIDER = { microsoft_teams: 'Teams', jira: 'Jira', github: 'GitHub', figma: 'Figma', outlook: 'Outlook', google_calendar: 'Google Calendar' };
const BLOCKING_INFO = ['missing_deadline', 'merged_duplicates', 'team_owner', 'ambiguous_team', 'merged_sources', 'completion_evidence', 'blocker_reported'];

function EvidenceItem({ e }) {
  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span className="font-medium uppercase tracking-wide">{RELATION[e.relation] ?? e.relation}</span>
        <span>
          {e.record ? `${PROVIDER[e.record.provider] ?? e.record.provider} ${e.record.recordType.replaceAll('_', ' ')}${e.record.key ? ` ${e.record.key}` : ''}` : e.meeting ? `Transcript of “${e.meeting.title}”${e.startSec !== null ? ` at ${formatTimestamp(e.startSec)}` : ''}` : 'Transcript'}
          {e.occurredAt ? ` · ${formatDateTime(e.occurredAt)}` : ''}
        </span>
      </div>
      <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 text-slate-800">
        “{e.excerpt}”{e.speaker && <span className="text-slate-500"> — {e.speaker}</span>}
      </blockquote>
      <div className="mt-1 flex gap-3 text-xs">
        {e.record && <Link className="underline" to={`/records/${e.record.id}`}>Open in WorkAgent</Link>}
        {e.record?.url && <a className="underline" href={e.record.url} target="_blank" rel="noreferrer">Open the original</a>}
        {e.meeting && <Link className="underline" to={`/admin/meetings/${e.meeting.id}`}>Open the meeting</Link>}
      </div>
    </li>
  );
}

function ReviewForm({ item, problems, onSaved }) {
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState({ title: item.title, assigneeUserId: item.assignee?.id ?? '', dueDate: item.dueDate ?? '', priority: item.priority, category: item.category ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    listPeople().then((d) => setPeople(d.users ?? [])).catch(() => {});
  }, []);
  const openFlags = item.flags.filter((f) => !BLOCKING_INFO.includes(f));
  async function save(extra = {}) {
    setBusy(true);
    setError(null);
    try {
      const body = { ...extra };
      if (form.title !== item.title) body.title = form.title;
      if (Number(form.assigneeUserId || 0) !== (item.assignee?.id ?? 0)) body.assigneeUserId = form.assigneeUserId ? Number(form.assigneeUserId) : null;
      if ((form.dueDate || null) !== (item.dueDate ?? null)) body.dueDate = form.dueDate || null;
      if (form.priority !== item.priority) body.priority = form.priority;
      if ((form.category || null) !== (item.category ?? null) && form.category) body.category = form.category;
      if (Object.keys(body).length) await editAction(item.id, body);
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <ErrorAlert error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Owner" hint={item.assigneeNameRaw ? `Said: “${item.assigneeNameRaw}”` : undefined}>
          <select className={inputClass} value={form.assigneeUserId} onChange={(e) => setForm({ ...form, assigneeUserId: e.target.value })}>
            <option value="">Nobody yet</option>
            {(item.reviewDetails?.assignee?.candidates?.length ? item.reviewDetails.assignee.candidates.map((c) => ({ id: c.id, fullName: `${c.fullName} (matches the name)` })) : []).concat(people).map((p, n) => (
              <option key={`${p.id}-${n}`} value={p.id}>{p.fullName}</option>
            ))}
          </select>
        </Field>
        <Field label="Due date" hint={item.dueDateRaw ? `Said: “${item.dueDateRaw}”${item.deadlineStatus === 'needs_clarification' ? ' — not resolved, please confirm' : ''}` : 'No deadline was stated'}>
          <input type="date" className={inputClass} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <select className={inputClass} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {['low', 'medium', 'high'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Category">
            <select className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
      </div>
      {openFlags.length > 0 && (
        <ul className="space-y-1 text-sm">
          {openFlags.map((f) => (
            <li key={f} className="flex items-center justify-between gap-2 rounded-md bg-amber-50 px-2 py-1 text-amber-900">
              {item.flagLabels?.[f] ?? f.replaceAll('_', ' ')}
              <Button variant="link" disabled={busy} onClick={() => save({ resolveFlags: [f] })}>
                Mark resolved
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && <p className="text-xs text-slate-500">Before approval: {problems.join('; ')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => save()}>
          Save changes
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await save();
              await reviewAction(item.id, 'approve');
              await onSaved('Approved.');
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Approve
        </Button>
        <Button variant="danger" disabled={busy} onClick={async () => {
          const reason = window.prompt('Why is this not an action item? (optional)') ?? null;
          try {
            await reviewAction(item.id, 'reject', reason ? { reason } : {});
            await onSaved('Rejected.');
          } catch (err) {
            setError(err);
          }
        }}>
          Reject
        </Button>
      </div>
    </div>
  );
}

export function ActionDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [acting, setActing] = useState(false);
  const load = useCallback(() => getAction(id).then(setD).catch(setError), [id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!d) return error ? <ErrorAlert error={error} /> : <Loading />;
  const i = d.actionItem;
  const isOwner = i.assignee?.id === user.id;

  async function act(fn, message) {
    setError(null);
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/actions" className="text-sm text-slate-500 hover:underline">
        ← Action Center
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{i.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {[i.categoryLabel, i.sourceLabel, i.project?.name, i.meeting ? `Meeting “${i.meeting.title}”` : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <LifecycleBadge state={i.lifecycle} />
      </div>
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          {i.description && <p className="whitespace-pre-wrap text-sm text-slate-700">{i.description}</p>}

          {d.permissions.canReview && i.reviewStatus === 'pending' && (
            <Card title="Review">
              <ReviewForm item={i} problems={d.permissions.approvalProblems} onSaved={async (m) => { if (m) setNotice(m); await load(); }} />
            </Card>
          )}

          <Card title={`Evidence (${d.evidence.length})`}>
            {d.evidence.length === 0 ? <p className="text-sm text-slate-500">Added manually; no source evidence.</p> : <ul className="space-y-2">{d.evidence.map((e) => <EvidenceItem key={e.id} e={e} />)}</ul>}
          </Card>

          <Card title="Actual state of the work">
            <p className="text-sm font-medium">{WORK_STATUS[d.workStatus.status] ?? d.workStatus.status}</p>
            {d.workStatus.signals.length ? (
              <ul className="mt-2 space-y-1 text-sm">
                {d.workStatus.signals.map((s) => (
                  <li key={s.recordId}>
                    {s.text}
                    {s.linkStatus === 'suggested' && <span className="ml-1 text-xs text-slate-500">(suggested link)</span>}
                    {' · '}
                    <Link className="underline" to={`/records/${s.recordId}`}>open</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-slate-500">No Jira issue, pull request, commit or design is linked yet. Links appear when a key or URL is mentioned, when someone confirms a suggestion, or when WorkAgent creates the issue.</p>
            )}
          </Card>

          <Card title="Executions in connected applications">
            {d.executions.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing has been executed for this item.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {d.executions.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <span className="font-medium">{x.kind.replace('.', ' · ').replaceAll('_', ' ')}</span>
                      <span className="ml-2 text-xs text-slate-500">{EXECUTION_STATUS[x.status] ?? x.status}{x.approvedBy ? ` · approved by ${x.approvedBy}` : ''}</span>
                      {x.lastError && <p className="text-xs text-red-700">{x.lastError}</p>}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      {x.externalUrl && (x.externalUrl.startsWith('/') ? <Link className="underline" to={x.externalUrl}>{x.externalKey ?? 'Open'}</Link> : <a className="underline" href={x.externalUrl} target="_blank" rel="noreferrer">{x.externalKey ?? 'Open'}</a>)}
                      {!x.externalUrl && x.externalKey && <span>{x.externalKey}</span>}
                      {['failed', 'retry_required'].includes(x.status) && (
                        <Button variant="secondary" onClick={() => act(() => retryExecution(x.id), 'Retry scheduled.')}>
                          Retry
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {d.permissions.canExecute && !acting && (
              <Button className="mt-3" variant="secondary" onClick={() => setActing(true)}>
                Act on this item…
              </Button>
            )}
            {acting && <div className="mt-3"><ExecutePanel itemIds={[i.id]} onClose={() => setActing(false)} onDone={() => load()} /></div>}
          </Card>

          <Card title="History">
            <ol className="space-y-1 text-sm">
              {d.history.map((h) => (
                <li key={h.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <span className="font-medium">{h.action.replaceAll('_', ' ').replace('.', ': ')}</span>
                    <span className="text-slate-500"> — {h.actor}</span>
                  </span>
                  <span className="text-xs text-slate-500">{formatDateTime(h.at)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card title="Details">
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-slate-500">Owner</dt><dd>{i.assignee?.fullName ?? i.assigneeTeam?.name ?? 'Unassigned'} <span className="text-xs text-slate-500">({OWNER_KIND[i.assigneeKind]})</span></dd></div>
              <div><dt className="text-xs text-slate-500">Due</dt><dd className={i.overdue ? 'font-medium text-red-700' : ''}>{i.dueDate ?? (i.dueDateRaw ? `“${i.dueDateRaw}” (not resolved)` : 'No deadline')}{i.dueTimezone ? <span className="text-xs text-slate-500"> {i.dueTimezone}</span> : ''}</dd></div>
              <div><dt className="text-xs text-slate-500">Priority</dt><dd className="capitalize">{i.priority}</dd></div>
              <div><dt className="text-xs text-slate-500">Work status</dt><dd>{i.taskStatus.replaceAll('_', ' ')}</dd></div>
              {i.aiConfidence !== null && <div><dt className="text-xs text-slate-500">AI confidence</dt><dd>{Math.round(i.aiConfidence * 100)}%</dd></div>}
              {i.sourceRecord?.url && <div><dt className="text-xs text-slate-500">Source</dt><dd><a className="underline" href={i.sourceRecord.url} target="_blank" rel="noreferrer">{i.sourceRecord.key ?? i.sourceLabel}</a></dd></div>}
            </dl>
          </Card>
          {i.reviewStatus === 'approved' && (isOwner || d.permissions.canReview) && (
            <Card title="Update status">
              <div className="flex flex-wrap gap-2">
                {['todo', 'in_progress', 'blocked', 'done'].map((s) => (
                  <Button key={s} variant={i.taskStatus === s ? 'primary' : 'secondary'} disabled={i.taskStatus === s} onClick={() => act(() => setActionStatus(i.id, s), 'Status updated.')}>
                    {s.replaceAll('_', ' ')}
                  </Button>
                ))}
              </div>
            </Card>
          )}
          {d.permissions.canReview && i.reviewStatus !== 'pending' && (
            <Button variant="secondary" onClick={() => act(() => reviewAction(i.id, 'reopen'), 'Reopened for review.')}>
              Reopen review
            </Button>
          )}
          {i.flags.length > 0 && i.reviewStatus !== 'pending' && (
            <Card title="Signals">
              <ul className="space-y-1 text-sm">{i.flags.map((f) => <li key={f}>{i.flagLabels?.[f] ?? f}</li>)}</ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
