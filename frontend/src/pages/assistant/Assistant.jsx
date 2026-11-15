// Conversational assistant: type or speak a request; WorkAgent shows what it understood as a card
// and does nothing until you confirm. Choices appear when a name, date or task is ambiguous.
// Executed commands can be undone for a short time where the tool allows it.
import { ArrowUp, CheckCircle2, ExternalLink, MessageSquare, Mic, Plus, ShieldCheck, Sparkles, Square, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  assistantCapabilities,
  cancelCommand,
  chooseOption,
  confirmCommand,
  deleteConversation,
  getConversation,
  listConversations,
  reviseCommand,
  sendAssistantMessage,
  transcribe,
  undoCommand,
} from '../../api/features.js';
import { IntegrationIcon } from '../../components/icons.jsx';
import { Button, Callout, ErrorAlert, Loading, TypingDots, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const EXAMPLES = [
  'Assign the OAuth refresh bug to Priya, due next Friday, high priority.',
  'Schedule a design review with the Payments department Thursday at 4 PM for one hour.',
  'Book a 30-minute follow-up with everyone who was in this morning’s standup tomorrow at 10am.',
  'Show me all overdue tasks assigned to me.',
  'Change the priority of the payment integration task to critical.',
  'Show me all action items from yesterday’s meetings.',
  'Create Jira tickets for all approved engineering action items.',
  'Email everyone who has pending action items.',
  'Who is blocking the Payments project?',
];

export function AssistantPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState(null);
  const [error, setError] = useState(null);

  const loadList = useCallback(() => listConversations().then((d) => setConversations(d.conversations)).catch(() => setConversations([])), []);
  useEffect(() => {
    loadList();
  }, [loadList]);

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="space-y-3 lg:sticky lg:top-[4.75rem] lg:max-h-[calc(100dvh-6.5rem)] lg:self-start lg:overflow-y-auto">
        <Button className="w-full" variant="secondary" icon={Plus} onClick={() => navigate('/assistant')}>
          New conversation
        </Button>
        {!conversations && <Loading rows={2} />}
        {conversations?.length > 0 && <p className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">History</p>}
        <ul className="space-y-px text-[13px]">
          {conversations?.map((c) => (
            <li key={c.id} className="group flex items-center gap-1">
              <Link
                to={`/assistant/${c.id}`}
                aria-current={Number(id) === c.id ? 'page' : undefined}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 ${Number(id) === c.id ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
              >
                <MessageSquare size={13} aria-hidden="true" className="shrink-0 text-slate-400" />
                <span className="truncate">{c.title}</span>
              </Link>
              <button
                type="button"
                aria-label={`Delete conversation ${c.title}`}
                title="Delete conversation"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-0 transition-opacity duration-150 hover:bg-red-50 hover:text-red-700 focus-visible:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
                onClick={async () => {
                  if (!window.confirm('Delete this conversation? Executed actions stay in the audit log.')) return;
                  await deleteConversation(c.id).catch(setError);
                  loadList();
                  if (Number(id) === c.id) navigate('/assistant');
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-col gap-4 lg:h-[calc(100dvh-6.5rem)] lg:min-h-[30rem]">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-100 text-accent-700">
            <Sparkles size={18} />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Assistant</h1>
            <p className="mt-0.5 text-sm text-slate-500">Schedule meetings, assign or update tasks, set deadlines, or ask about task status. Nothing is changed until you confirm.</p>
          </div>
        </div>
        <ErrorAlert error={error} />
        <AssistantChat
          fill
          conversationId={id ? Number(id) : null}
          onConversation={(cid) => {
            if (!id || Number(id) !== cid) navigate(`/assistant/${cid}`, { replace: Boolean(id) });
            loadList();
          }}
        />
      </section>
    </div>
  );
}

/**
 * The conversation itself (messages, cards, input). Used by the Assistant page and by the
 * assistant dock that is available on every page (components/AssistantDock.jsx).
 */
export function AssistantChat({ conversationId = null, onConversation = () => {}, compact = false, fill = false, examples = EXAMPLES }) {
  const [caps, setCaps] = useState(null);
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [inputMode, setInputMode] = useState('text');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the request being sent, shown until the server answers
  const [error, setError] = useState(null);
  const bottom = useRef(null);

  useEffect(() => {
    assistantCapabilities().then(setCaps).catch(setError);
  }, []);
  useEffect(() => {
    if (!conversationId) {
      setConv(null);
      return;
    }
    if (conv?.conversation.id === conversationId) return;
    getConversation(conversationId).then(setConv).catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [conv, pending]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setConv(next);
      onConversation(next.conversation.id);
    } catch (err) {
      setError(err);
      if (conv?.conversation.id) getConversation(conv.conversation.id).then(setConv).catch(() => {});
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  function send(e) {
    e?.preventDefault();
    if (!text.trim()) return;
    const body = { text: text.trim(), inputMode, conversationId: conv?.conversation.id ?? null };
    setText('');
    setInputMode('text');
    setPending(body);
    run(() => sendAssistantMessage(body));
  }

  const commands = new Map((conv?.commands ?? []).map((c) => [c.id, c]));
  const lastMessageFor = new Map();
  for (const m of conv?.messages ?? []) if (m.commandId) lastMessageFor.set(m.commandId, m.id);

  const stretch = compact || fill;
  return (
    <div className={stretch ? 'flex h-full min-h-0 flex-1 flex-col gap-3' : 'space-y-4'}>
      {caps && !caps.ai.configured && <ErrorAlert error="The AI service (WorkAPI) is not configured on the server, so requests cannot be understood yet." />}
      <ErrorAlert error={error} />
      <div className={`space-y-5 ${compact ? 'px-1 py-1' : 'rounded-xl border border-slate-200 bg-white p-5 sm:p-6'} ${stretch ? 'min-h-0 flex-1 overflow-y-auto' : ''}`} aria-live="polite">
        {!conv && !pending && (
          <div className={`flex h-full flex-col justify-center ${compact ? 'py-2' : 'mx-auto max-w-2xl py-6'}`}>
            {!compact && (
              <div className="mb-6 text-center">
                <span aria-hidden="true" className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-100 text-accent-700">
                  <Sparkles size={20} />
                </span>
                <p className="mt-3 text-base font-semibold text-slate-900">What should WorkAgent do?</p>
                <p className="mt-1 text-sm text-slate-500">Describe it in your own words. You will see exactly what will happen before anything is changed.</p>
              </div>
            )}
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">Try:</p>
            <ul className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
              {examples.map((ex) => (
                <li key={ex}>
                  <button
                    type="button"
                    className="h-full w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left text-[13px] text-slate-700 transition-colors duration-150 hover:border-accent-300 hover:bg-accent-50 hover:text-slate-900"
                    onClick={() => setText(ex)}
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {conv?.messages.map((m) => (
          <div key={m.id}>
            <Message role={m.role} voice={m.inputMode === 'voice'}>
              {m.content}
            </Message>
            {m.role === 'assistant' && m.commandId && lastMessageFor.get(m.commandId) === m.id && commands.get(m.commandId) && (
              <div className="ml-9">
                <CommandCard cmd={commands.get(m.commandId)} busy={busy} run={run} />
              </div>
            )}
          </div>
        ))}
        {pending && (
          <Message role="user" voice={pending.inputMode === 'voice'}>
            {pending.text}
          </Message>
        )}
        {busy && (
          <div className="flex items-center gap-3">
            <AssistantAvatar />
            <TypingDots label="WorkAgent is working" />
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="rounded-xl border border-slate-300 bg-white shadow-xs transition-colors focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-100">
        <textarea
          aria-label="Your request"
          rows={compact ? 2 : 3}
          className="block w-full resize-none rounded-xl border-0 !bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-slate-400 focus:outline-none focus-visible:outline-none disabled:opacity-60"
          placeholder="Type a request…"
          value={text}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) setInputMode('text');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e);
          }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <VoiceButton caps={caps} disabled={busy} onText={(t) => { setText(t); setInputMode('voice'); }} onError={setError} />
          <span className="flex items-center gap-3">
            {!compact && <span className="hidden text-xs text-slate-400 sm:inline">Enter to send · Shift + Enter for a new line</span>}
            <Button type="submit" size="sm" icon={busy ? undefined : ArrowUp} loading={busy} disabled={busy || !text.trim()}>
              {busy ? 'Working…' : 'Send'}
            </Button>
          </span>
        </div>
      </form>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-100 text-accent-700">
      <Sparkles size={13} />
    </span>
  );
}

/** One chat message: the person's request on the right, WorkAgent's reply on the left. */
function Message({ role, voice, children }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-slate-100 px-3.5 py-2 text-sm text-slate-900">
          {voice && <Mic size={12} aria-label="spoken" role="img" className="mr-1.5 inline align-[-1px] text-slate-500" />}
          {children}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <AssistantAvatar />
      <p className="min-w-0 max-w-[90%] whitespace-pre-wrap break-words pt-0.5 text-sm leading-6 text-slate-800">{children}</p>
    </div>
  );
}

/** Voice: the server's speech-to-text when configured, else the browser's speech recognition. */
function VoiceButton({ caps, disabled, onText, onError }) {
  const [recording, setRecording] = useState(false);
  const recorder = useRef(null);
  const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition ?? window.webkitSpeechRecognition : undefined;
  const server = caps?.speech?.configured && typeof window !== 'undefined' && window.MediaRecorder;
  const available = server || Recognition;

  async function start() {
    if (server) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        const rec = new window.MediaRecorder(stream, { mimeType: window.MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined });
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setRecording(false);
          try {
            const r = await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
            if (r.text) onText(r.text);
            else onError('No speech was recognised.');
          } catch (err) {
            onError(err);
          }
        };
        recorder.current = rec;
        rec.start();
        setRecording(true);
        setTimeout(() => rec.state === 'recording' && rec.stop(), 55_000);
      } catch {
        onError('Microphone access was not allowed.');
      }
    } else if (Recognition) {
      const r = new Recognition();
      r.lang = caps?.speech?.language ?? 'en-US';
      r.interimResults = false;
      r.onresult = (e) => onText(Array.from(e.results).map((x) => x[0].transcript).join(' '));
      r.onerror = (e) => onError(`Speech recognition failed (${e.error}).`);
      r.onend = () => setRecording(false);
      recorder.current = r;
      r.start();
      setRecording(true);
    }
  }
  const stop = () => recorder.current?.stop();
  return (
    <Button
      variant={recording ? 'danger' : 'ghost'}
      size="sm"
      icon={recording ? Square : Mic}
      aria-pressed={recording}
      aria-label={recording ? 'Stop recording' : 'Speak a request'}
      title={available ? 'Speak a request; you can edit the text before sending' : 'Voice input is not available in this browser and server speech-to-text is not configured'}
      disabled={disabled || !available}
      onClick={recording ? stop : start}
    >
      <span aria-hidden="true">{recording ? 'Stop' : 'Speak'}</span>
    </Button>
  );
}

function UndoButton({ cmd, busy, run }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((new Date(cmd.undoDeadline) - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((new Date(cmd.undoDeadline) - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [cmd.undoDeadline]);
  if (left <= 0) return null;
  return (
    <Button variant="secondary" size="sm" icon={Undo2} disabled={busy} onClick={() => run(() => undoCommand(cmd.id))}>
      Undo ({left}s)
    </Button>
  );
}

function CommandCard({ cmd, busy, run }) {
  const [largeOk, setLargeOk] = useState(false);
  const r = cmd.resolution ?? {};
  if (cmd.status === 'needs_clarification' && r.pending?.length) {
    const p = r.pending[0];
    return (
      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <p className="font-medium text-slate-900">{p.reason}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {p.options.map((o) => (
            <Button key={o.id} variant="secondary" disabled={busy} onClick={() => run(() => chooseOption(cmd.id, p.key, o.id))}>
              {o.label}
              {o.detail && <span className="ml-1 text-xs text-slate-500">{o.detail}</span>}
            </Button>
          ))}
          <Button variant="link" disabled={busy} onClick={() => run(() => cancelCommand(cmd.id))}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (cmd.status === 'awaiting_confirmation' && cmd.plan?.action === 'engine_plan') return <EnginePlanCard cmd={cmd} busy={busy} run={run} />;
  if (cmd.status === 'awaiting_confirmation' && cmd.plan) {
    const plan = cmd.plan;
    return (
      <div className="mt-3 overflow-hidden rounded-xl border border-accent-200 bg-white text-sm shadow-xs" role="group" aria-label="Confirm action">
        <PreviewHeader provider={plan.externalWrite ? plan.provider : 'workagent'} />
        <div className="p-4">
        <p className="font-semibold text-slate-900">{plan.headline}</p>
        <p className="mt-1 text-xs text-slate-500">
          Requested by {plan.requestedBy} · {plan.externalWrite ? `writes to ${plan.provider === 'jira' ? 'Jira' : plan.provider === 'outlook' ? 'Outlook / Teams' : 'Google Calendar'}` : 'changes WorkAgent only'}
        </p>
        <dl className="mt-3 grid gap-x-4 gap-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[10rem_1fr]">
          {plan.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-slate-500">{f.label}</dt>
              <dd className={f.flagged ? 'font-medium text-amber-800' : ''}>
                {f.value}
                {f.flagged && ' ⚠'}
              </dd>
            </div>
          ))}
        </dl>
        {plan.action === 'meeting_create' && (
          <div className="mt-3 space-y-2">
            <label className="flex items-center gap-2">
              <span className="text-slate-500">Calendar</span>
              <select
                className={`${inputClass} !w-auto`}
                value={`${plan.meetingInput.provider}:${plan.meetingInput.connectionId ?? ''}`}
                disabled={busy}
                onChange={(e) => {
                  const [provider, connectionId] = e.target.value.split(':');
                  run(() => reviseCommand(cmd.id, { provider, connectionId: connectionId ? Number(connectionId) : null }));
                }}
              >
                {plan.calendars.map((c) => (
                  <option key={`${c.provider}:${c.connectionId ?? ''}`} value={`${c.provider}:${c.connectionId ?? ''}`} disabled={!c.canWrite}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary className="cursor-pointer">Invitees ({plan.recipientCount})</summary>
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                {plan.invitees.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    {p.fullName}
                    <button type="button" className="text-xs text-red-700 hover:underline" disabled={busy} onClick={() => run(() => reviseCommand(cmd.id, { excludedUserIds: [...(plan.meetingInput.excludedUserIds ?? []), p.id] }))}>
                      Exclude
                    </button>
                  </li>
                ))}
              </ul>
            </details>
            {plan.availability?.conflicts?.length > 0 && <p className="text-amber-800">Busy then: {plan.availability.conflicts.map((c) => c.fullName).join(', ')}{plan.availability.suggestions?.length ? `. Free: ${plan.availability.suggestions.map((s) => formatDateTime(s.startAt)).join(', ')}` : ''}</p>}
          </div>
        )}
        {plan.affected?.length > 0 && plan.action !== 'meeting_create' && <p className="mt-3">Affects: {plan.affected.map((a) => `${a.fullName} (${a.role})`).join(', ')}</p>}
        {plan.warnings?.map((w) => (
          <Callout key={w} tone="warning" className="mt-2">
            {w}
          </Callout>
        ))}
        {plan.blockers?.map((b) => (
          <Callout key={b} tone="danger" className="mt-2">
            {b}
          </Callout>
        ))}
        {plan.requiresLargeConfirmation && (
          <label className="mt-2 flex items-center gap-2 text-red-800">
            <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm inviting {plan.recipientCount} people.
          </label>
        )}
        <p className="mt-2 text-xs text-slate-500">{plan.undo}</p>
        </div>
        <div className="flex gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <Button icon={ShieldCheck} disabled={busy || plan.blockers?.length > 0 || (plan.requiresLargeConfirmation && !largeOk)} onClick={() => run(() => confirmCommand(cmd.id, largeOk))}>
            Confirm
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => run(() => cancelCommand(cmd.id))}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (cmd.status === 'executed') {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>Done{cmd.externalKey ? `: ${cmd.externalKey}` : ''}.</span>
        </span>
        {cmd.externalUrl && (
          <a href={cmd.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
            Open in {cmd.provider === 'jira' ? 'Jira' : 'calendar'}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
        {cmd.externalRecordId && <Link to={`/records/${cmd.externalRecordId}`} className="underline underline-offset-2">Open in WorkAgent</Link>}
        {cmd.meetingId && <Link to={`/meetings/scheduled/${cmd.meetingId}`} className="underline underline-offset-2">Open meeting</Link>}
        {cmd.canUndo && <UndoButton cmd={cmd} busy={busy} run={run} />}
      </div>
    );
  }
  if (cmd.status === 'answered' && cmd.result?.items?.length) {
    return (
      <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
        {cmd.result.items.map((i, n) => (
          <li key={i.ref ? `${i.ref.type}${i.ref.id}` : `row${n}`} className="flex flex-wrap justify-between gap-2 px-3.5 py-2.5">
            {i.url ? <Link to={i.url} className="font-medium text-slate-900 hover:underline">{i.title}</Link> : <span className="font-medium text-slate-900">{i.title}</span>}
            <span className="text-xs text-slate-500">
              {i.status}
              {i.dueDate ? ` · due ${i.dueDate}` : ''}
              {i.overdueDays ? ` · ${i.overdueDays} days overdue` : ''}
              {i.owner ? ` · ${i.owner}` : ''}
              {i.work ? ` · ${i.work.replaceAll('_', ' ')}` : ''}
            </span>
            {i.blocker && <span className="w-full text-xs text-slate-600">{i.blocker}</span>}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

/** A bulk operation prepared by the execution engine: every write, recipient and message, then confirm. */
function EnginePlanCard({ cmd, busy, run }) {
  const [largeOk, setLargeOk] = useState(false);
  const plan = cmd.plan;
  const p = plan.engine.preview;
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-accent-200 bg-white text-sm shadow-xs" role="group" aria-label="Confirm action">
      <PreviewHeader provider={p.provider} />
      <div className="p-4">
      <p className="font-semibold text-slate-900">{plan.headline}</p>
      <p className="mt-1 text-xs text-slate-500">
        {p.providerLabel} · {p.affected.records} write{p.affected.records === 1 ? '' : 's'} · {p.affected.people} {p.affected.people === 1 ? 'person' : 'people'} affected · {p.cancelSeconds ? `${p.cancelSeconds}-second cancel window after confirming` : 'runs at once'}
      </p>
      {p.recipients?.length > 0 && <p className="mt-2">Recipients: {p.recipients.map((r) => `${r.name} <${r.email}>`).join(', ')}</p>}
      <ul className="mt-3 space-y-2">
        {p.drafts.map((d, n) => (
          <li key={n} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="font-medium text-slate-900">{d.title}</p>
            {d.target && <p className="text-xs text-slate-500">→ {d.target}</p>}
            {d.skipped && <p className="text-xs text-slate-500">Skipped: {d.skipped}</p>}
            {d.content && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs">Exact content</summary>
                <dl className="mt-1 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[6rem_1fr]">
                  {Object.entries(d.content).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className="whitespace-pre-wrap">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            {d.warnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-800">{w}</p>)}
            {d.blockers.map((b) => <p key={b} className="mt-1 text-xs text-red-700">{b}</p>)}
          </li>
        ))}
      </ul>
      {plan.warnings?.map((w) => <Callout key={w} tone="warning" className="mt-2">{w}</Callout>)}
      {plan.blockers?.map((b) => <Callout key={b} tone="danger" className="mt-2">{b}</Callout>)}
      {plan.requiresLargeConfirmation && (
        <label className="mt-2 flex items-center gap-2 text-red-800">
          <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm this bulk operation ({p.affected.records} writes, {p.affected.people} people).
        </label>
      )}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
        <Button icon={ShieldCheck} disabled={busy || plan.blockers?.length > 0 || !plan.engine.planId || (plan.requiresLargeConfirmation && !largeOk)} onClick={() => run(() => confirmCommand(cmd.id, largeOk))}>
          Confirm
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => run(() => cancelCommand(cmd.id))}>
          Cancel
        </Button>
        {plan.engine.planId && <Link className="self-center text-xs font-medium text-accent-700 underline-offset-2 hover:underline sm:ml-auto" to={`/approvals?plan=${plan.engine.planId}`}>Open on the Approvals page</Link>}
      </div>
    </div>
  );
}

/** Strip at the top of a confirmation card: this is a preview, and which application it touches. */
function PreviewHeader({ provider }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-accent-200 bg-accent-50 px-4 py-2">
      <IntegrationIcon provider={provider ?? 'workagent'} size={22} />
      <span className="text-xs font-medium uppercase tracking-wider text-accent-800">Execution preview</span>
      <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-600">
        <TriangleAlert size={12} aria-hidden="true" />
        Nothing happens until you confirm
      </span>
    </div>
  );
}
