// Vexa meeting transcription: connect once, then Google Meet meetings found in connected calendars
// are transcribed automatically under the organisation's policy. Replaces the former standalone
// Google Meet integration.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { connectVexa, disconnectVexa, retryVexaSession, saveVexaSettings, skipVexaSession, syncVexa, vexaOverview } from '../../api/vexa.js';
import { Button, ErrorAlert, Field, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const STATE = {
  connected: { label: 'Connected · automatic transcription on', cls: 'bg-emerald-100 text-emerald-800' },
  paused: { label: 'Connected · automatic transcription off', cls: 'bg-slate-100 text-slate-700' },
  disconnected: { label: 'Not connected', cls: 'bg-slate-100 text-slate-600' },
  not_configured: { label: 'Configuration required', cls: 'bg-amber-100 text-amber-800' },
};
const SESSION = {
  scheduled: 'Scheduled',
  dispatching: 'Sending bot',
  joining: 'Joining',
  recording: 'Recording',
  processing: 'Waiting for transcript',
  completed: 'Transcribed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Not recorded',
};
const DEFAULT_CONSENT = 'Meeting invitations state that WorkAgent transcribes the meeting. The bot joins as a visible participant, must be admitted by the host, and participants can ask the host to remove it.';

const Stat = ({ label, value }) => (
  <div className="rounded-lg border border-slate-200 px-3 py-2">
    <dt className="text-[11px] uppercase text-slate-500">{label}</dt>
    <dd className="text-lg font-semibold text-slate-900">{value ?? 0}</dd>
  </div>
);

export function VexaLogo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-label="Vexa logo" role="img">
      <rect width="32" height="32" rx="7" fill="#111827" />
      <path d="M8 10l8 13 8-13" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function VexaCard() {
  const [v, setV] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(DEFAULT_CONSENT);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState(null);
  const load = useCallback(() => vexaOverview().then((d) => { setV(d); setDraft(d.settings); }).catch(setError), []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn, message) {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const r = await fn();
      if (r?.provider === 'vexa') {
        setV(r);
        setDraft(r.settings);
      } else await load();
      setNotice(message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  if (!v) return error ? <ErrorAlert error={`Could not load Vexa: ${error.message}`} /> : null;
  const st = STATE[v.state] ?? STATE.disconnected;
  const failed = v.sessions.filter((s) => s.state === 'failed');

  return (
    <section aria-label="Vexa meeting transcription" className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <VexaLogo />
          <div>
            <h2 className="font-semibold text-slate-900">{v.displayName}</h2>
            <p className="text-xs text-slate-500">Transcribes Google Meet meetings automatically. Connect once; no per-meeting setup and no separate Google Meet integration.</p>
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${st.cls}`}>{st.label}</span>
      </div>
      <ErrorAlert error={error} className="mt-3" />
      <div className="mt-3">
        <SuccessAlert>{notice}</SuccessAlert>
      </div>

      {v.state === 'not_configured' && (
        <p className="mt-3 text-sm text-amber-800">
          The server needs <code>VEXA_BASE_URL</code> and <code>VEXA_API_KEY</code> (see the integrations runbook). Optional: <code>VEXA_WEBHOOK_SECRET</code> and <code>VEXA_WEBHOOK_PUBLIC_URL</code> for instant status updates.
        </p>
      )}

      {v.state === 'disconnected' && (
        <div className="mt-4 space-y-3">
          <Field label="How participants are told and consent" hint="Stored with the connection and shown to admins. Required before any meeting is recorded.">
            <textarea rows={3} className={inputClass} value={consent} onChange={(e) => setConsent(e.target.value)} />
          </Field>
          <Button disabled={busy || consent.trim().length < 20} onClick={() => run(() => connectVexa({ consentStatement: consent.trim() }), 'Vexa connected. Upcoming Google Meet meetings are checked every minute.')}>
            Connect Vexa and turn on automatic transcription
          </Button>
        </div>
      )}

      {['connected', 'paused'].includes(v.state) && (
        <>
          <dl className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Meetings transcribed" value={v.counts.meetingsProcessed} />
            <Stat label="Upcoming" value={v.counts.upcoming} />
            <Stat label="In progress" value={v.counts.active} />
            <Stat label="Failed (30 days)" value={v.counts.failed30d} />
            <Stat label="Not recorded (30 days)" value={v.counts.skipped30d} />
            <Stat label="Bot capacity" value={v.account?.maxConcurrent ?? '—'} />
          </dl>
          <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="text-slate-500">Vexa account</dt>
            <dd>{v.account?.email ?? '—'} {v.account?.verifiedAt && <span className="text-xs text-slate-500">(verified {formatDateTime(v.account.verifiedAt)})</span>}</dd>
            <dt className="text-slate-500">Bot</dt>
            <dd>
              “{v.bot.name}” on {v.bot.platform} · status checked every {v.bot.pollIntervalSeconds}s · {v.bot.autoExtract ? 'action items extracted automatically' : 'extraction is manual'}
            </dd>
            <dt className="text-slate-500">Status updates</dt>
            <dd>{v.webhook.registered ? 'Signed Vexa webhook + polling' : `Polling only${v.webhook.reason ? ` (${v.webhook.reason})` : ''}`}</dd>
            <dt className="text-slate-500">Meeting discovery</dt>
            <dd>
              {v.discoverySources.length
                ? v.discoverySources.map((s) => (s.provider === 'google_calendar' ? 'Google Calendar' : 'Outlook calendar')).join(', ')
                : <span className="text-amber-800">No calendar connected — connect Google Calendar or Outlook below so meetings can be found.</span>}
            </dd>
            <dt className="text-slate-500">Last transcript</dt>
            <dd>{v.lastTranscript ? <><Link className="underline" to={`/admin/meetings/${v.lastTranscript.meetingId}`}>{v.lastTranscript.title}</Link> · {formatDateTime(v.lastTranscript.at)}</> : 'None yet'}</dd>
            <dt className="text-slate-500">Consent</dt>
            <dd className="text-slate-700">{v.settings.consent?.statement ?? '—'}</dd>
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => run(syncVexa, 'Checking calendars now.')}>
              Check calendars now
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => saveVexaSettings({ enabled: !v.settings.enabled }), v.settings.enabled ? 'Automatic transcription paused.' : 'Automatic transcription on.')}>
              {v.settings.enabled ? 'Pause automatic transcription' : 'Resume automatic transcription'}
            </Button>
            <Button variant="secondary" onClick={() => setShowSettings((x) => !x)}>
              {showSettings ? 'Hide settings' : 'Transcription settings'}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => window.confirm('Disconnect Vexa? Upcoming meetings are no longer recorded; bots already in a meeting finish.') && run(disconnectVexa, 'Disconnected. Upcoming meetings will not be recorded.')}>
              Disconnect
            </Button>
          </div>

          {showSettings && draft && (
            <div className="mt-4 grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
              <Field label="Which meetings">
                <select className={inputClass} value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                  <option value="organizer">Organised by a WorkAgent member</option>
                  <option value="member_attends">Organised or attended by a WorkAgent member</option>
                </select>
              </Field>
              <Field label="Opt-out keywords" hint="A meeting whose title or description contains one is never recorded">
                <input className={inputClass} value={draft.optOutKeywords.join(', ')} onChange={(e) => setDraft({ ...draft, optOutKeywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })} />
              </Field>
              <Field label="Send the bot (minutes before start)">
                <input type="number" min={0} max={15} className={inputClass} value={draft.joinLeadMinutes} onChange={(e) => setDraft({ ...draft, joinLeadMinutes: Number(e.target.value) })} />
              </Field>
              <Field label="Longest meeting to record (hours)">
                <input type="number" min={1} max={8} className={inputClass} value={draft.maxDurationHours} onChange={(e) => setDraft({ ...draft, maxDurationHours: Number(e.target.value) })} />
              </Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={draft.internalOnly} onChange={(e) => setDraft({ ...draft, internalOnly: e.target.checked })} /> Only meetings without attendees from outside the organisation
              </label>
              <div className="sm:col-span-2">
                <Button disabled={busy} onClick={() => run(() => saveVexaSettings({ scope: draft.scope, optOutKeywords: draft.optOutKeywords, joinLeadMinutes: draft.joinLeadMinutes, maxDurationHours: draft.maxDurationHours, internalOnly: draft.internalOnly }), 'Settings saved.')}>
                  Save settings
                </Button>
              </div>
            </div>
          )}

          <h3 className="mt-5 text-sm font-semibold">Meetings{failed.length ? ` · ${failed.length} failed` : ''}</h3>
          {v.sessions.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">No Google Meet meetings found yet in the next {24} hours.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1 pr-3">Meeting</th>
                    <th className="py-1 pr-3">Starts</th>
                    <th className="py-1 pr-3">State</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {v.sessions.map((s) => (
                    <tr key={s.id} className="align-top">
                      <td className="py-2 pr-3">
                        {s.meetingId ? <Link className="underline" to={`/admin/meetings/${s.meetingId}`}>{s.title}</Link> : s.title}
                        <div className="text-xs text-slate-500">{s.organizerEmail}</div>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">{formatDateTime(s.scheduledStart)}</td>
                      <td className="py-2 pr-3">
                        <span className={s.state === 'failed' ? 'font-medium text-red-700' : ''}>{SESSION[s.state] ?? s.state}</span>
                        {s.reason && <div className="text-xs text-slate-500">{s.reason}</div>}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right">
                        {['failed', 'skipped', 'cancelled'].includes(s.state) && (
                          <Button variant="secondary" disabled={busy} onClick={() => run(() => retryVexaSession(s.id), 'Retry scheduled.')}>
                            Retry
                          </Button>
                        )}
                        {s.state === 'scheduled' && (
                          <Button variant="link" disabled={busy} onClick={() => run(() => skipVexaSession(s.id), 'This meeting will not be recorded.')}>
                            Don’t record
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
