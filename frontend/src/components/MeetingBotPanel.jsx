import { Bot, CheckCircle2, CircleAlert, Loader, Radio, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkBot, getBot, importBotTranscript, requestBot, stopBot } from '../api/bot.js';
import { formatDateTime } from '../utils/format.js';
import { Button, ErrorAlert, Loading, SuccessAlert } from './ui.jsx';

const POLL_MS = 5000;
// Meeting statuses during which the bot is live (mirrors backend services/vexa/mapper.js).
const LIVE = ['bot_requested', 'bot_joining', 'in_progress'];
const LIVE_BOT = ['requested', 'joining', 'awaiting_admission', 'needs_human_help', 'needs_help', 'active', 'stopping'];

function statusLine(view) {
  const b = view.bot;
  switch (b.status) {
    case 'requested':
      return ['info', 'Bot requested — starting up…'];
    case 'joining':
      return ['info', 'The bot is joining the meeting…'];
    case 'awaiting_admission':
      return ['warn', 'The bot is waiting in the lobby. Admit “Meeting to Action” in Google Meet so it can transcribe.'];
    case 'needs_human_help':
    case 'needs_help':
      return ['warn', 'The bot needs help joining (for example a sign-in prompt). Check the meeting.'];
    case 'active':
      return ['live', 'The bot is in the meeting and transcribing.'];
    case 'stopping':
      return ['info', 'The bot is leaving the meeting…'];
    case 'completed':
      if (view.transcript?.source === 'vexa') return ['ok', `Meeting ended. Transcript imported from the bot (${view.transcript.segmentCount} segments).`];
      if (view.transcript) return ['ok', 'Meeting ended. This meeting already has a transcript, so the bot’s transcript was not imported automatically.'];
      if (view.polling) return ['info', 'The meeting has ended. Waiting for the transcript to be ready…'];
      return ['warn', view.lastError ?? 'The meeting has ended but no transcript was imported.'];
    case 'failed':
      return ['error', `The bot failed${b.reasonText ? `: ${b.reasonText}` : ''}.`];
    default:
      return ['info', `Bot status: ${b.status ?? 'unknown'}`];
  }
}

const TONE = {
  info: { cls: 'border-sky-200 bg-sky-50 text-sky-900', Icon: Loader },
  live: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', Icon: Radio },
  ok: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', Icon: CheckCircle2 },
  warn: { cls: 'border-amber-200 bg-amber-50 text-amber-900', Icon: TriangleAlert },
  error: { cls: 'border-red-200 bg-red-50 text-red-800', Icon: CircleAlert },
};

/**
 * Vexa bot controls for a meeting. All state comes from our backend (GET /meetings/:id/bot);
 * polls only while the bot is live or a transcript is awaited, and stops on unmount.
 */
export function MeetingBotPanel({ meetingId, onMeetingChanged }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null); // which action is running
  const lastStatus = useRef(null);

  const load = useCallback(async () => {
    try {
      const { bot } = await getBot(meetingId);
      setView(bot);
      setError(null);
      return bot;
    } catch (err) {
      setError(err);
      return null;
    }
  }, [meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  // Tell the page when the meeting status changes (e.g. transcript imported -> extraction).
  useEffect(() => {
    if (!view) return;
    if (lastStatus.current && lastStatus.current !== view.meetingStatus) onMeetingChanged?.();
    lastStatus.current = view.meetingStatus;
  }, [view, onMeetingChanged]);

  const shouldPoll = Boolean(view && (LIVE.includes(view.meetingStatus) || (view.meetingStatus === 'ended' && view.polling)));
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const timer = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer);
  }, [shouldPoll, view, load]);

  async function run(name, fn, success) {
    if (busy) return;
    setBusy(name);
    setActionError(null);
    setNotice('');
    try {
      const result = await fn();
      if (result?.bot) setView(result.bot);
      else await load();
      setNotice(typeof success === 'function' ? success(result) : success);
      onMeetingChanged?.();
    } catch (err) {
      setActionError(err);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (error && !view) return <ErrorAlert error={`Could not load the meeting bot status: ${error.message}`} />;
  if (!view) return <Loading label="Loading bot status…" />;

  const b = view.bot;
  const live = b && LIVE_BOT.includes(b.status) && LIVE.includes(view.meetingStatus);
  const canImport = b && b.status === 'completed' && view.transcript?.source !== 'vexa' && ['ended', 'transcript_ready', 'failed', 'draft'].includes(view.meetingStatus);

  const request = () => {
    if (!window.confirm('Send the meeting bot? It joins the Google Meet as “Meeting to Action”, records and transcribes it. Let participants know.')) return;
    run('request', () => requestBot(meetingId), 'Bot requested. It will join shortly.');
  };
  const stop = () => {
    if (!window.confirm('Stop the bot? It leaves the meeting and the transcript so far is processed.')) return;
    run('stop', () => stopBot(meetingId), 'The bot is leaving the meeting.');
  };
  const importTranscript = () => {
    const replace = Boolean(view.transcript);
    if (replace && !window.confirm('Replace the current transcript with the bot’s transcript? The current segments will be deleted.')) return;
    run('import', () => importBotTranscript(meetingId, replace), (r) =>
      r.extraction === 'queued' ? 'Transcript imported. AI extraction has been queued.' : 'Transcript imported.',
    );
  };

  return (
    <div className="space-y-3" aria-live="polite">
      {!view.configured && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
          The meeting bot isn’t configured on the server (VEXA_BASE_URL / VEXA_API_KEY). You can still upload a transcript manually.
        </p>
      )}

      {view.configured && !b && !view.linkValid && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          The bot can only join Google Meet links like https://meet.google.com/abc-defg-hij. Edit the meeting link, or upload a transcript instead.
        </p>
      )}

      {b && (() => {
        const [tone, text] = statusLine(view);
        const { cls, Icon } = TONE[tone];
        return (
          <div className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${cls}`} role="status">
            <Icon size={15} aria-hidden="true" className={`mt-0.5 shrink-0 ${tone === 'live' ? 'animate-pulse' : ''}`} />
            <div className="min-w-0">
            <p>{text}</p>
            {b.status === 'failed' && view.lastError && <p className="mt-1 text-xs">{view.lastError}</p>}
            {view.meetingStatus === 'extracting' && <p className="mt-1 text-xs">AI extraction has been queued from this transcript.</p>}
            {view.meetingStatus === 'transcript_ready' && b.status === 'completed' && !view.autoExtract && (
              <p className="mt-1 text-xs">Automatic extraction is off; start it from the Action items section.</p>
            )}
            <p className="mt-1 text-xs opacity-75">
              Requested {formatDateTime(b.requestedAt)}
              {b.checkedAt && ` · last checked ${formatDateTime(b.checkedAt)}`}
            </p>
            </div>
          </div>
        );
      })()}

      {b && view.polling?.lastError && (
        <p className="text-xs text-amber-700">Having trouble reaching Vexa; retrying automatically.</p>
      )}

      <SuccessAlert>{notice}</SuccessAlert>
      <ErrorAlert error={actionError} />

      <div className="flex flex-wrap gap-2">
        {view.canRequest && (
          <Button icon={Bot} onClick={request} disabled={Boolean(busy)}>
            {busy === 'request' ? 'Requesting…' : b ? 'Send the bot again' : 'Send bot to meeting'}
          </Button>
        )}
        {live && (
          <Button variant="danger" onClick={stop} disabled={Boolean(busy)}>
            {busy === 'stop' ? 'Stopping…' : 'Stop bot'}
          </Button>
        )}
        {b && view.configured && (
          <Button variant="secondary" onClick={() => run('check', () => checkBot(meetingId), 'Status updated from Vexa.')} disabled={Boolean(busy)}>
            {busy === 'check' ? 'Checking…' : 'Check status'}
          </Button>
        )}
        {canImport && view.configured && (
          <Button variant="secondary" onClick={importTranscript} disabled={Boolean(busy)}>
            {busy === 'import' ? 'Importing…' : view.transcript ? 'Replace with Vexa transcript' : 'Import Vexa transcript'}
          </Button>
        )}
      </div>
      {view.configured && !view.canRequest && !b && view.linkValid && view.cannotRequestReason && (
        <p className="text-xs text-slate-500">{view.cannotRequestReason}</p>
      )}
    </div>
  );
}
