// Conversational assistant: type or speak a request; WorkAgent shows what it understood as a card
// and does nothing until you confirm. Choices appear when a name, date or task is ambiguous.
// Executed commands can be undone for a short time where the tool allows it.
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
import { Button, ErrorAlert, Loading, inputClass } from '../../components/ui.jsx';
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
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-3">
        <Button className="w-full" variant="secondary" onClick={() => navigate('/assistant')}>
          New conversation
        </Button>
        {!conversations && <Loading />}
        <ul className="space-y-1 text-sm">
          {conversations?.map((c) => (
            <li key={c.id} className="flex items-center gap-1">
              <Link to={`/assistant/${c.id}`} className={`block flex-1 truncate rounded-md px-2 py-1.5 ${Number(id) === c.id ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'}`}>
                {c.title}
              </Link>
              <button
                type="button"
                aria-label={`Delete conversation ${c.title}`}
                className="px-1 text-xs text-slate-400 hover:text-red-700"
                onClick={async () => {
                  if (!window.confirm('Delete this conversation? Executed actions stay in the audit log.')) return;
                  await deleteConversation(c.id).catch(setError);
                  loadList();
                  if (Number(id) === c.id) navigate('/assistant');
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Assistant</h1>
          <p className="mt-1 text-sm text-slate-500">Schedule meetings, assign or update tasks, set deadlines, or ask about task status. Nothing is changed until you confirm.</p>
        </div>
        <ErrorAlert error={error} />
        <AssistantChat
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
export function AssistantChat({ conversationId = null, onConversation = () => {}, compact = false, examples = EXAMPLES }) {
  const [caps, setCaps] = useState(null);
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [inputMode, setInputMode] = useState('text');
  const [busy, setBusy] = useState(false);
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
  }, [conv]);

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
    }
  }

  function send(e) {
    e?.preventDefault();
    if (!text.trim()) return;
    const body = { text: text.trim(), inputMode, conversationId: conv?.conversation.id ?? null };
    setText('');
    setInputMode('text');
    run(() => sendAssistantMessage(body));
  }

  const commands = new Map((conv?.commands ?? []).map((c) => [c.id, c]));
  const lastMessageFor = new Map();
  for (const m of conv?.messages ?? []) if (m.commandId) lastMessageFor.set(m.commandId, m.id);

  return (
    <div className={compact ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-4'}>
      {caps && !caps.ai.configured && <ErrorAlert error="The AI service (WorkAPI) is not configured on the server, so requests cannot be understood yet." />}
      <ErrorAlert error={error} />
      <div className={`space-y-3 rounded-xl border border-slate-200 bg-white p-4 ${compact ? 'min-h-0 flex-1 overflow-y-auto' : ''}`} aria-live="polite">
        {!conv && (
          <div className="text-sm text-slate-500">
            <p>Try:</p>
            <ul className="mt-2 space-y-1">
              {examples.map((ex) => (
                <li key={ex}>
                  <button type="button" className="text-left text-slate-700 underline-offset-2 hover:underline" onClick={() => setText(ex)}>
                    “{ex}”
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {conv?.messages.map((m) => (
          <div key={m.id}>
            <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <p className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-900'}`}>
                {m.inputMode === 'voice' && <span className="mr-1" aria-label="spoken">🎙</span>}
                {m.content}
              </p>
            </div>
            {m.role === 'assistant' && m.commandId && lastMessageFor.get(m.commandId) === m.id && commands.get(m.commandId) && (
              <CommandCard cmd={commands.get(m.commandId)} busy={busy} run={run} />
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="flex items-end gap-2">
        <textarea
          aria-label="Your request"
          rows={2}
          className={inputClass}
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
        <VoiceButton caps={caps} disabled={busy} onText={(t) => { setText(t); setInputMode('voice'); }} onError={setError} />
        <Button type="submit" disabled={busy || !text.trim()}>
          {busy ? 'Working…' : 'Send'}
        </Button>
      </form>
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
      variant="secondary"
      aria-pressed={recording}
      aria-label={recording ? 'Stop recording' : 'Speak a request'}
      title={available ? 'Speak a request; you can edit the text before sending' : 'Voice input is not available in this browser and server speech-to-text is not configured'}
      disabled={disabled || !available}
      onClick={recording ? stop : start}
    >
      {recording ? '■ Stop' : '🎙 Speak'}
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
    <Button variant="secondary" disabled={busy} onClick={() => run(() => undoCommand(cmd.id))}>
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
      <div className="mt-2 rounded-lg border border-slate-200 p-3 text-sm">
        <p className="font-medium">{p.reason}</p>
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
      <div className="mt-2 rounded-lg border-2 border-slate-900 p-4 text-sm" role="group" aria-label="Confirm action">
        <p className="font-semibold">{plan.headline}</p>
        <p className="mt-1 text-xs text-slate-500">
          Requested by {plan.requestedBy} · {plan.externalWrite ? `writes to ${plan.provider === 'jira' ? 'Jira' : plan.provider === 'outlook' ? 'Outlook / Teams' : 'Google Calendar'}` : 'changes WorkAgent only'}
        </p>
        <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
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
                className="rounded-md border border-slate-300 px-2 py-1"
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
          <p key={w} className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800">
            {w}
          </p>
        ))}
        {plan.blockers?.map((b) => (
          <p key={b} className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700">
            {b}
          </p>
        ))}
        {plan.requiresLargeConfirmation && (
          <label className="mt-2 flex items-center gap-2 text-red-800">
            <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm inviting {plan.recipientCount} people.
          </label>
        )}
        <p className="mt-2 text-xs text-slate-500">{plan.undo}</p>
        <div className="mt-3 flex gap-2">
          <Button disabled={busy || plan.blockers?.length > 0 || (plan.requiresLargeConfirmation && !largeOk)} onClick={() => run(() => confirmCommand(cmd.id, largeOk))}>
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
      <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
        <span>Done{cmd.externalKey ? `: ${cmd.externalKey}` : ''}.</span>
        {cmd.externalUrl && (
          <a href={cmd.externalUrl} target="_blank" rel="noreferrer" className="underline">
            Open in {cmd.provider === 'jira' ? 'Jira' : 'calendar'}
          </a>
        )}
        {cmd.externalRecordId && <Link to={`/records/${cmd.externalRecordId}`} className="underline">Open in WorkAgent</Link>}
        {cmd.meetingId && <Link to={`/meetings/scheduled/${cmd.meetingId}`} className="underline">Open meeting</Link>}
        {cmd.canUndo && <UndoButton cmd={cmd} busy={busy} run={run} />}
      </div>
    );
  }
  if (cmd.status === 'answered' && cmd.result?.items?.length) {
    return (
      <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
        {cmd.result.items.map((i, n) => (
          <li key={i.ref ? `${i.ref.type}${i.ref.id}` : `row${n}`} className="flex flex-wrap justify-between gap-2 px-3 py-2">
            {i.url ? <Link to={i.url} className="hover:underline">{i.title}</Link> : <span>{i.title}</span>}
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
    <div className="mt-2 rounded-lg border-2 border-slate-900 p-4 text-sm" role="group" aria-label="Confirm action">
      <p className="font-semibold">{plan.headline}</p>
      <p className="mt-1 text-xs text-slate-500">
        {p.providerLabel} · {p.affected.records} write{p.affected.records === 1 ? '' : 's'} · {p.affected.people} {p.affected.people === 1 ? 'person' : 'people'} affected · {p.cancelSeconds ? `${p.cancelSeconds}-second cancel window after confirming` : 'runs at once'}
      </p>
      {p.recipients?.length > 0 && <p className="mt-2">Recipients: {p.recipients.map((r) => `${r.name} <${r.email}>`).join(', ')}</p>}
      <ul className="mt-3 space-y-2">
        {p.drafts.map((d, n) => (
          <li key={n} className="rounded-md border border-slate-200 p-2">
            <p className="font-medium">{d.title}</p>
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
      {plan.warnings?.map((w) => <p key={w} className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800">{w}</p>)}
      {plan.blockers?.map((b) => <p key={b} className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700">{b}</p>)}
      {plan.requiresLargeConfirmation && (
        <label className="mt-2 flex items-center gap-2 text-red-800">
          <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} /> I confirm this bulk operation ({p.affected.records} writes, {p.affected.people} people).
        </label>
      )}
      <div className="mt-3 flex gap-2">
        <Button disabled={busy || plan.blockers?.length > 0 || !plan.engine.planId || (plan.requiresLargeConfirmation && !largeOk)} onClick={() => run(() => confirmCommand(cmd.id, largeOk))}>
          Confirm
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => run(() => cancelCommand(cmd.id))}>
          Cancel
        </Button>
        {plan.engine.planId && <Link className="self-center text-xs underline" to={`/approvals?plan=${plan.engine.planId}`}>Open on the Approvals page</Link>}
      </div>
    </div>
  );
}
