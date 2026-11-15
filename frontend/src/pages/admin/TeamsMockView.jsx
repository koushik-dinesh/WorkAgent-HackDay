// "View Teams" for the Microsoft Teams DEVELOPMENT MOCK: the imported teams, channels, messages
// (with replies and reactions) and meetings (with their WorkAgent meeting and transcript), all read
// from WorkAgent's database — the same records the rest of the app uses.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { teamsMockView } from '../../api/integrationOverview.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Card, ErrorAlert, Loading } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';
import { TeamsLogo } from './IntegrationCards.jsx';

const REACTION = { like: '👍', heart: '❤️', check: '✅', eyes: '👀', rocket: '🚀', thinking: '🤔' };
const reaction = (r) => {
  const [k, n] = String(r).split(':');
  return `${REACTION[k] ?? k} ${n ?? ''}`.trim();
};

export function TeamsMockViewPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [team, setTeam] = useState(null);
  useEffect(() => {
    teamsMockView()
      .then((d) => {
        setData(d);
        setTeam(d.teams[0]?.id ?? null);
      })
      .catch(setError);
  }, []);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  const current = data.teams.find((t) => t.id === team);
  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/integrations" className="text-sm text-slate-500 hover:underline">
          ← Integrations
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <TeamsLogo />
          <h1 className="text-2xl font-semibold">Microsoft Teams — Violin Technologies</h1>
          <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-semibold uppercase text-white">Development mock</span>
        </div>
        <p className="mt-1 text-sm text-slate-500">Fictional data imported through WorkAgent’s normal sync. No Microsoft account is involved.</p>
      </div>
      {data.teams.length === 0 && <EmptyState title="No mock data">Use “Sync Mock Data” on the Integrations page.</EmptyState>}
      {data.teams.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
          <ul className="space-y-1 text-sm" aria-label="Teams">
            {data.teams.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setTeam(t.id)} className={`w-full rounded-md px-3 py-2 text-left ${team === t.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}>
                  {t.name}
                  <span className={`block text-xs ${team === t.id ? 'text-slate-300' : 'text-slate-500'}`}>{t.channels.length} channels</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="space-y-4">
            {current?.channels.map((ch) => (
              <Card key={ch.resourceId} title={`# ${ch.name}`}>
                {ch.messages.length === 0 && <p className="text-sm text-slate-500">No messages.</p>}
                <ul className="space-y-4">
                  {ch.messages.map((m) => (
                    <li key={m.id} className="text-sm">
                      <p>
                        <span className="font-medium">{m.author}</span> <span className="text-xs text-slate-500">{formatDateTime(m.at)}</span>
                      </p>
                      {m.title && !String(m.body ?? '').startsWith(m.title.replace(/…$/, '')) && <p className="font-medium text-slate-800">{m.title}</p>}
                      <p className="whitespace-pre-wrap text-slate-700">{m.body}</p>
                      {m.reactions.length > 0 && <p className="mt-1 text-xs text-slate-600">{m.reactions.map(reaction).join('  ')}</p>}
                      {m.replies.length > 0 && (
                        <ul className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3">
                          {m.replies.map((r) => (
                            <li key={r.id}>
                              <span className="font-medium">{r.author}</span> <span className="text-xs text-slate-500">{formatDateTime(r.at)}</span>
                              <p className="text-slate-700">{r.body}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </div>
      )}
      {data.meetings.length > 0 && (
        <Card title={`Meetings (${data.meetings.length})`}>
          <ul className="divide-y divide-slate-100 text-sm">
            {data.meetings.map((m) => (
              <li key={m.recordId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {m.meetingId ? (
                    <Link to={`/admin/meetings/${m.meetingId}`} className="font-medium hover:underline">
                      {m.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{m.title}</span>
                  )}
                  <span className="block text-xs text-slate-500">
                    {formatDateTime(m.start)} · {m.team ?? '—'} · {m.project ?? 'no project'} · {m.attendees} attendees
                  </span>
                </span>
                <span className="text-xs text-slate-600">{m.transcriptSegments ? `Transcript: ${m.transcriptSegments} lines` : `Transcript ${m.importStatus ?? 'not imported'}`}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
