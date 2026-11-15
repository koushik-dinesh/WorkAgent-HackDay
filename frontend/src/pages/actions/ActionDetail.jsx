// One action item with its complete evidence trail: where it was said or written (transcript
// line, Teams message, Jira/GitHub/Figma comment), supporting evidence from other sources, the
// real state of the linked work, every execution in connected applications, and the audit history.
import { CalendarDays, ExternalLink, Flag, Gauge, Play, RotateCcw, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { editAction, getAction, retryExecution, reviewAction, setActionStatus } from '../../api/actions.js';
import { listPeople } from '../../api/directory.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ExecutePanel } from '../../components/actions/ExecutePanel.jsx';
import { CATEGORIES, EXECUTION_STATUS, LifecycleBadge, OWNER_KIND, PriorityIndicator, WORK_STATUS } from '../../components/actions/labels.jsx';
import { SourceIcon } from '../../components/icons.jsx';
import { ActivityTimeline, Badge, Button, Card, ErrorAlert, Field, Loading, Meter, PageHeader, Person, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDate, formatDateTime, formatTimestamp } from '../../utils/format.js';

const RELATION = { origin: 'Where it was agreed', supporting: 'Also mentioned', progress: 'Progress', completion: 'Completion evidence' };
const PROVIDER = { microsoft_teams: 'Teams', jira: 'Jira', github: 'GitHub', figma: 'Figma', outlook: 'Outlook', google_calendar: 'Google Calendar' };
const BLOCKING_INFO = ['missing_deadline', 'merged_duplicates', 'team_owner', 'ambiguous_team', 'merged_sources', 'completion_evidence', 'blocker_reported'];

const RELATION_TONE = { origin: 'accent', supporting: 'neutral', progress: 'info', completion: 'success' };
const EXECUTION_TONE = { awaiting_approval: 'warning', scheduled: 'info', executing: 'info', succeeded: 'success', verified: 'success', failed: 'danger', retry_required: 'danger', cancelled: 'muted', rejected: 'muted' };
const WORK_TONE = { not_started: 'neutral', in_progress: 'info', implementation_complete: 'warning', blocked: 'danger', done: 'success' };
const linkClass = 'font-medium text-accent-700 underline-offset-2 hover:underline';

function EvidenceItem({ e }) {
  return (
    <li className="rounded-lg border border-slate-200 p-3.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <Badge tone={RELATION_TONE[e.relation] ?? 'neutral'}>{RELATION[e.relation] ?? e.relation}</Badge>
        <span className="inline-flex items-center gap-1.5">
          <SourceIcon source={e.record?.provider ?? 'meeting'} size={13} />
          {e.record ? `${PROVIDER[e.record.provider] ?? e.record.provider} ${e.record.recordType.replaceAll('_', ' ')}${e.record.key ? ` ${e.record.key}` : ''}` : e.meeting ? `Transcript of “${e.meeting.title}”${e.startSec !== null ? ` at ${formatTimestamp(e.startSec)}` : ''}` : 'Transcript'}
          {e.occurredAt ? ` · ${formatDateTime(e.occurredAt)}` : ''}
        </span>
      </div>
      <blockquote className="mt-2.5 border-l-2 border-accent-300 pl-3 text-slate-800">
        “{e.excerpt}”{e.speaker && <span className="text-slate-500"> — {e.speaker}</span>}
      </blockquote>
      <div className="mt-2.5 flex flex-wrap gap-4 text-xs">
        {e.record && <Link className={linkClass} to={`/records/${e.record.id}`}>Open in WorkAgent</Link>}
        {e.record?.url && <a className={linkClass} href={e.record.url} target="_blank" rel="noreferrer">Open the original</a>}
        {e.meeting && <Link className={linkClass} to={`/admin/meetings/${e.meeting.id}`}>Open the meeting</Link>}
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
            <li key={f} className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-900">
              {item.flagLabels?.[f] ?? f.replaceAll('_', ' ')}
              <Button variant="link" disabled={busy} onClick={() => save({ resolveFlags: [f] })}>
                Mark resolved
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && <p className="text-xs text-slate-500">Before approval: {problems.join('; ')}</p>}
      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
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

  const owner = i.assignee?.fullName ?? i.assigneeTeam?.name;
  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: '/actions', label: 'Action Center' }}
        title={i.title}
        badge={<LifecycleBadge state={i.lifecycle} />}
        meta={
          <>
            {i.categoryLabel && <span>{i.categoryLabel}</span>}
            <span className="inline-flex items-center gap-1.5">
              <SourceIcon source={i.source} size={13} />
              {i.sourceLabel}
            </span>
            {i.project?.name && <Link to={`/projects/${i.project.id}`} className="hover:text-slate-900 hover:underline">{i.project.name}</Link>}
            {i.meeting && <span>Meeting “{i.meeting.title}”</span>}
          </>
        }
        actions={
          d.permissions.canReview && i.reviewStatus !== 'pending' && (
            <Button variant="secondary" icon={RotateCcw} onClick={() => act(() => reviewAction(i.id, 'reopen'), 'Reopened for review.')}>
              Reopen review
            </Button>
          )
        }
      />
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-6">
          {i.description && <p className="max-w-3xl whitespace-pre-wrap text-sm leading-6 text-slate-700">{i.description}</p>}

          {d.permissions.canReview && i.reviewStatus === 'pending' && (
            <Card title="Review" description="Confirm the owner, deadline and wording before this becomes a task.">
              <ReviewForm item={i} problems={d.permissions.approvalProblems} onSaved={async (m) => { if (m) setNotice(m); await load(); }} />
            </Card>
          )}

          <Card title={`Evidence (${d.evidence.length})`} description="Where this was said or written, and what supports it.">
            {d.evidence.length === 0 ? <p className="text-sm text-slate-500">Added manually; no source evidence.</p> : <ul className="space-y-3">{d.evidence.map((e) => <EvidenceItem key={e.id} e={e} />)}</ul>}
          </Card>

          <Card title="Actual state of the work" actions={<Badge tone={WORK_TONE[d.workStatus.status] ?? 'neutral'} dot>{WORK_STATUS[d.workStatus.status] ?? d.workStatus.status}</Badge>}>
            {d.workStatus.signals.length ? (
              <ul className="space-y-2 text-sm">
                {d.workStatus.signals.map((s) => (
                  <li key={s.recordId} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-slate-800">{s.text}</span>
                    {s.linkStatus === 'suggested' && <span className="text-xs text-slate-500">(suggested link)</span>}
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <Link className={`text-xs ${linkClass}`} to={`/records/${s.recordId}`}>open</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No Jira issue, pull request, commit or design is linked yet. Links appear when a key or URL is mentioned, when someone confirms a suggestion, or when WorkAgent creates the issue.</p>
            )}
          </Card>

          <Card
            title="Executions in connected applications"
            actions={
              d.permissions.canExecute && !acting && (
                <Button variant="secondary" size="sm" icon={Play} onClick={() => setActing(true)}>
                  Act on this item…
                </Button>
              )
            }
          >
            {d.executions.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing has been executed for this item.</p>
            ) : (
              <ul className="-my-2 divide-y divide-slate-100 text-sm">
                {d.executions.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <span className="inline-flex items-center gap-2">
                        <SourceIcon source={x.kind.split('.')[0]} size={14} />
                        <span className="font-medium">{x.kind.replace('.', ' · ').replaceAll('_', ' ')}</span>
                      </span>
                      <span className="ml-2 text-xs text-slate-500">{EXECUTION_STATUS[x.status] ?? x.status}{x.approvedBy ? ` · approved by ${x.approvedBy}` : ''}</span>
                      {x.lastError && <p className="mt-0.5 text-xs text-red-700">{x.lastError}</p>}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${{ success: 'bg-emerald-500', danger: 'bg-red-500', info: 'bg-sky-500', warning: 'bg-amber-500' }[EXECUTION_TONE[x.status]] ?? 'bg-slate-300'}`} />
                      {x.externalUrl && (x.externalUrl.startsWith('/') ? <Link className={linkClass} to={x.externalUrl}>{x.externalKey ?? 'Open'}</Link> : <a className={`inline-flex items-center gap-1 ${linkClass}`} href={x.externalUrl} target="_blank" rel="noreferrer">{x.externalKey ?? 'Open'}<ExternalLink size={11} aria-hidden="true" /></a>)}
                      {!x.externalUrl && x.externalKey && <span>{x.externalKey}</span>}
                      {['failed', 'retry_required'].includes(x.status) && (
                        <Button variant="secondary" size="sm" icon={RotateCcw} onClick={() => act(() => retryExecution(x.id), 'Retry scheduled.')}>
                          Retry
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {acting && <div className="mt-4"><ExecutePanel itemIds={[i.id]} onClose={() => setActing(false)} onDone={() => load()} /></div>}
          </Card>

          <Card title="History">
            <ActivityTimeline
              items={d.history.map((h) => ({
                key: h.id,
                title: <span className="font-medium">{h.action.replaceAll('_', ' ').replace('.', ': ')}</span>,
                detail: `— ${h.actor}`,
                at: formatDateTime(h.at),
                tone: /fail|reject/.test(h.action) ? 'danger' : /approv|verified|complet/.test(h.action) ? 'success' : 'neutral',
              }))}
            />
          </Card>
        </div>

        <aside className="space-y-4">
          <Card title="Details">
            <dl className="space-y-3.5 text-sm">
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-slate-500"><UserRound size={12} aria-hidden="true" />Owner</dt>
                <dd className="mt-1">
                  {owner ? <Person name={owner} /> : 'Unassigned'} <span className="text-xs text-slate-500">({OWNER_KIND[i.assigneeKind]})</span>
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-slate-500"><CalendarDays size={12} aria-hidden="true" />Due</dt>
                <dd className={`mt-1 ${i.overdue ? 'font-medium text-red-700' : ''}`}>{i.dueDate ? <span title={i.dueDate}>{formatDate(i.dueDate)}</span> : i.dueDateRaw ? `“${i.dueDateRaw}” (not resolved)` : 'No deadline'}{i.dueTimezone ? <span className="text-xs text-slate-500"> {i.dueTimezone}</span> : ''}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-slate-500"><Flag size={12} aria-hidden="true" />Priority</dt>
                <dd className="mt-1 flex items-center gap-1.5 capitalize"><PriorityIndicator priority={i.priority} />{i.priority}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Work status</dt>
                <dd className="mt-1">{i.taskStatus.replaceAll('_', ' ')}</dd>
              </div>
              {i.aiConfidence !== null && (
                <div>
                  <dt className="flex items-center gap-1.5 text-xs text-slate-500"><Gauge size={12} aria-hidden="true" />AI confidence</dt>
                  <dd className="mt-1">
                    {Math.round(i.aiConfidence * 100)}%
                    <Meter className="mt-1.5" value={Math.round(i.aiConfidence * 100)} max={100} tone={i.aiConfidence >= 0.75 ? 'success' : i.aiConfidence >= 0.5 ? 'warning' : 'danger'} label="AI confidence" />
                  </dd>
                </div>
              )}
              {i.sourceRecord?.url && (
                <div>
                  <dt className="text-xs text-slate-500">Source</dt>
                  <dd className="mt-1"><a className={`inline-flex items-center gap-1 ${linkClass}`} href={i.sourceRecord.url} target="_blank" rel="noreferrer">{i.sourceRecord.key ?? i.sourceLabel}<ExternalLink size={11} aria-hidden="true" /></a></dd>
                </div>
              )}
            </dl>
          </Card>
          {i.reviewStatus === 'approved' && (isOwner || d.permissions.canReview) && (
            <Card title="Update status">
              <div className="flex flex-wrap gap-2">
                {['todo', 'in_progress', 'blocked', 'done'].map((s) => (
                  <Button key={s} size="sm" className="capitalize" variant={i.taskStatus === s ? 'primary' : 'secondary'} disabled={i.taskStatus === s} onClick={() => act(() => setActionStatus(i.id, s), 'Status updated.')}>
                    {s.replaceAll('_', ' ')}
                  </Button>
                ))}
              </div>
            </Card>
          )}
          {i.flags.length > 0 && i.reviewStatus !== 'pending' && (
            <Card title="Signals">
              <ul className="space-y-1.5 text-sm text-slate-700">{i.flags.map((f) => <li key={f}>{i.flagLabels?.[f] ?? f}</li>)}</ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
