// Schedule a meeting with people and groups. Two steps, as the server requires: review the
// resolved attendee list (counts, why each person is invited, conflicts, exclusions), then
// confirm — with a second confirmation for large invitations.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { listCalendars, previewMeeting, scheduleMeeting } from '../../api/features.js';
import { AttendeePicker, TypeBadge } from '../../components/AttendeePicker.jsx';
import { Button, Card, ErrorAlert, Field, inputClass } from '../../components/ui.jsx';
import { formatDateTime, fromLocalInput } from '../../utils/format.js';

const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function ScheduleMeetingPage() {
  const navigate = useNavigate();
  const [calendars, setCalendars] = useState(null);
  const [form, setForm] = useState({ title: '', start: '', durationMinutes: 30, timeZone: browserTz(), calendar: 'workagent:', recurring: false, frequency: 'weekly', count: 4, membershipMode: 'pinned' });
  const [attendees, setAttendees] = useState({ people: [], groups: [], excludedUserIds: [] });
  const [preview, setPreview] = useState(null);
  const [largeOk, setLargeOk] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listCalendars()
      .then((d) => setCalendars(d.calendars))
      .catch(setError);
  }, []);

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
    setPreview(null);
  };
  const body = () => {
    const [provider, connectionId] = form.calendar.split(':');
    return {
      title: form.title,
      startAt: fromLocalInput(form.start),
      durationMinutes: Number(form.durationMinutes),
      timeZone: form.timeZone,
      provider,
      connectionId: connectionId ? Number(connectionId) : null,
      attendees: { userIds: attendees.people.map((p) => p.id), groupIds: attendees.groups.map((g) => g.id) },
      excludedUserIds: attendees.excludedUserIds,
      recurrence: form.recurring ? { frequency: form.frequency, interval: 1, count: Number(form.count) } : null,
      membershipMode: form.recurring ? form.membershipMode : 'pinned',
    };
  };

  async function review(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewMeeting(body()));
      setLargeOk(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await scheduleMeeting({ ...body(), confirm: true, recipientsHash: preview.recipientsHash, largeConfirmed: largeOk });
      navigate(`/meetings/scheduled/${res.meeting.id}`);
    } catch (err) {
      if (err.code === 'RECIPIENTS_CHANGED') {
        setPreview(null);
        setError('The attendee list changed since you reviewed it (group membership changed). Review it again.');
      } else setError(err);
    } finally {
      setBusy(false);
    }
  }

  const writable = (calendars ?? []).filter((c) => c.canWrite);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Schedule a meeting</h1>
          <p className="mt-1 text-sm text-slate-500">Invite people, departments, roles, project teams or groups. You review the final list before anything is sent.</p>
        </div>
        <Link to="/meetings/scheduled" className="text-sm text-slate-700 underline-offset-2 hover:underline">
          My scheduled meetings
        </Link>
      </div>
      <ErrorAlert error={error} />
      <form onSubmit={review} className="space-y-6">
        <Card title="Meeting">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Title">
              <input className={inputClass} required maxLength={255} value={form.title} onChange={set('title')} />
            </Field>
            <Field label="Starts" hint={`Time zone: ${form.timeZone}`}>
              <input type="datetime-local" className={inputClass} required value={form.start} onChange={set('start')} />
            </Field>
            <Field label="Duration (minutes)">
              <input type="number" min={5} max={1440} className={inputClass} required value={form.durationMinutes} onChange={set('durationMinutes')} />
            </Field>
            <Field label="Send invitations from" hint="Only your own connected calendars can send invitations.">
              <select className={inputClass} value={form.calendar} onChange={set('calendar')}>
                {(calendars ?? []).map((c) => (
                  <option key={`${c.provider}:${c.connectionId ?? ''}`} value={`${c.provider}:${c.connectionId ?? ''}`} disabled={!c.canWrite}>
                    {c.label}
                    {c.canWrite ? '' : ' — read-only'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {calendars && writable.length < calendars.length && (
            <p className="mt-3 text-xs text-amber-700">{calendars.find((c) => !c.canWrite)?.problem}</p>
          )}
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.recurring} onChange={set('recurring')} /> Recurring
            </label>
            {form.recurring && (
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Repeats">
                  <select className={inputClass} value={form.frequency} onChange={set('frequency')}>
                    <option value="weekly">Weekly</option>
                    <option value="daily">Daily</option>
                  </select>
                </Field>
                <Field label="Occurrences">
                  <input type="number" min={2} max={52} className={inputClass} value={form.count} onChange={set('count')} />
                </Field>
                <Field label="Group membership" hint="Dynamic re-resolves groups before occurrences; pinned keeps the confirmed list.">
                  <select className={inputClass} value={form.membershipMode} onChange={set('membershipMode')}>
                    <option value="pinned">Pinned (confirmed list)</option>
                    <option value="dynamic">Dynamic (current members)</option>
                  </select>
                </Field>
              </div>
            )}
          </div>
        </Card>
        <Card title="Attendees">
          <AttendeePicker
            value={attendees}
            onChange={(v) => {
              setAttendees(v);
              setPreview(null);
            }}
          />
        </Card>
        {!preview && (
          <Button type="submit" disabled={busy || (!attendees.people.length && !attendees.groups.length)}>
            {busy ? 'Resolving…' : 'Review attendees'}
          </Button>
        )}
      </form>

      {preview && (
        <Card title="Review and confirm">
          <div className="space-y-4">
            <p className="text-sm">
              <strong>{preview.total}</strong> {preview.total === 1 ? 'person' : 'people'} will be invited to “{preview.meeting.title}” on {formatDateTime(preview.meeting.startAt)} ({preview.meeting.timeZone}), from <strong>{preview.calendar.label}</strong>.
            </p>
            {preview.warnings.map((w) => (
              <p key={w} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {w}
              </p>
            ))}
            {preview.groups.length > 0 && (
              <ul className="flex flex-wrap gap-2 text-sm">
                {preview.groups.map((g) => (
                  <li key={g.id} className="flex items-center gap-2 rounded-full border border-slate-200 px-2 py-1">
                    <TypeBadge kind={g.type} /> {g.name}: {g.memberCount}
                    {g.large && <span className="text-xs font-medium text-red-700">large</span>}
                  </li>
                ))}
              </ul>
            )}
            {preview.availability.checked ? (
              preview.availability.conflicts.length ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                  <p className="font-medium text-amber-900">{preview.availability.conflicts.length} invitee(s) are busy then:</p>
                  <ul className="mt-1 list-disc pl-5 text-amber-900">
                    {preview.availability.conflicts.map((c) => (
                      <li key={c.userId}>{c.fullName}</li>
                    ))}
                  </ul>
                  {preview.availability.suggestions.length > 0 && <p className="mt-2 text-amber-900">Free slots for everyone checked: {preview.availability.suggestions.map((s) => formatDateTime(s.startAt)).join(', ')}</p>}
                </div>
              ) : (
                <p className="text-sm text-emerald-700">Everyone checked is free then.</p>
              )
            ) : (
              <p className="text-xs text-slate-500">Availability not checked: {preview.availability.problem ?? 'no calendar connected'}.</p>
            )}
            <details open={preview.total <= 30}>
              <summary className="cursor-pointer text-sm font-medium">Final attendee list ({preview.total})</summary>
              <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {preview.invitees.map((p) => (
                  <li key={p.id}>
                    {p.fullName} <span className="text-xs text-slate-500">— {p.via.map((v) => (v.type === 'individual' ? 'invited directly' : `via ${v.name}`)).join(', ')}</span>
                  </li>
                ))}
              </ul>
              {preview.excluded.length > 0 && <p className="mt-2 text-xs text-slate-500">Excluded: {preview.excluded.map((p) => p.fullName).join(', ')}</p>}
            </details>
            {preview.requiresLargeConfirmation && (
              <label className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <input type="checkbox" checked={largeOk} onChange={(e) => setLargeOk(e.target.checked)} />
                <span>
                  This invites {preview.total} people (more than {preview.threshold} or a group above that size). I confirm this large invitation.
                </span>
              </label>
            )}
            <div className="flex gap-2">
              <Button onClick={send} disabled={busy || preview.total === 0 || (preview.requiresLargeConfirmation && !largeOk) || !preview.calendar.canWrite}>
                {busy ? 'Sending…' : `Send ${preview.total} invitation${preview.total === 1 ? '' : 's'}`}
              </Button>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Change
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
