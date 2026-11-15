import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { cancelScheduled, getScheduled, listScheduled } from '../../api/features.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { TypeBadge } from '../../components/AttendeePicker.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading, StatusBadge, SuccessAlert } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const PROVIDER = { workagent: 'WorkAgent only', outlook: 'Outlook / Teams', google_calendar: 'Google Calendar / Meet' };

export function ScheduledMeetingsPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState('mine');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setData(null);
    listScheduled(scope)
      .then((d) => setData(d.meetings))
      .catch(setError);
  }, [scope]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Scheduled meetings</h1>
          <p className="mt-1 text-sm text-slate-500">Meetings you organised or were invited to through WorkAgent.</p>
        </div>
        <div className="flex items-center gap-3">
          {user.role === 'admin' && (
            <select aria-label="Which meetings" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="mine">Mine</option>
              <option value="all">Everyone’s</option>
            </select>
          )}
          <Link to="/meetings/schedule" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800">
            Schedule a meeting
          </Link>
        </div>
      </div>
      <ErrorAlert error={error} />
      {!data && !error && <Loading />}
      {data?.length === 0 && <EmptyState title="No scheduled meetings">Schedule one, or ask the assistant.</EmptyState>}
      {data?.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {data.map((m) => (
            <li key={m.meetingId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div>
                <Link to={`/meetings/scheduled/${m.meetingId}`} className="font-medium text-slate-900 hover:underline">
                  {m.title}
                </Link>
                <p className="text-xs text-slate-500">
                  {formatDateTime(m.startAt)} · {m.recipientCount} invited · {PROVIDER[m.provider]} · organiser {m.organizerName}
                </p>
              </div>
              <StatusBadge status={m.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ScheduledMeetingDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    getScheduled(id)
      .then(setData)
      .catch(setError);
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel() {
    if (!window.confirm('Cancel this meeting? Attendees will be told.')) return;
    setBusy(true);
    try {
      const r = await cancelScheduled(id);
      setNotice(r.providerCancelled ? 'Cancelled. The calendar sent attendees a cancellation.' : 'Cancelled.');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <ErrorAlert error={error.status === 404 ? 'Meeting not found.' : error} />;
  if (!data) return <Loading />;
  const s = data.schedule;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{data.meeting.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {formatDateTime(s.startAt)} – {formatDateTime(s.endAt)} ({s.timeZone}) · organised by {s.organizer?.fullName} · {PROVIDER[s.provider]}
            {s.recurrence ? ` · ${s.recurrence.count} × ${s.recurrence.frequency}, ${s.membershipMode} membership` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={s.status} />
          {data.permissions.canCancel && (
            <Button variant="danger" onClick={cancel} disabled={busy}>
              Cancel meeting
            </Button>
          )}
        </div>
      </div>
      <SuccessAlert>{notice}</SuccessAlert>
      <ErrorAlert error={error} />
      {s.lastError && <ErrorAlert error={`Sending failed: ${s.lastError}`} />}
      {data.meeting.meetingUrl && (
        <p className="text-sm">
          Join link:{' '}
          <a href={data.meeting.meetingUrl} target="_blank" rel="noreferrer" className="text-slate-900 underline">
            {data.meeting.meetingUrl}
          </a>
        </p>
      )}
      {data.groups.length > 0 && (
        <Card title="Groups invited">
          <ul className="flex flex-wrap gap-2 text-sm">
            {data.groups.map((g) => (
              <li key={g.id} className="flex items-center gap-2 rounded-full border border-slate-200 px-2 py-1">
                <TypeBadge kind={g.type} /> {g.name} ({g.memberCount}
                {g.pinned ? ', pinned' : ''})
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={`Attendees (${data.invitees.filter((i) => !i.excluded).length})`}>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {data.invitees.map((i) => (
            <li key={i.userId} className={i.excluded ? 'text-slate-400 line-through' : ''}>
              {i.fullName}
              {i.via && <span className="ml-1 text-xs text-slate-500">{i.excluded ? '(excluded)' : `— ${i.via.map((v) => (v.type === 'individual' ? 'directly' : `via ${v.name}`)).join(', ')}`}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
