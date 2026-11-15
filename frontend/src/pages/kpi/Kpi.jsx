// Work metrics: the employee's own view first (notice, metrics, the events behind each one,
// misattribution, who viewed it), the team lead's team view, the HR aggregate view, and the admin
// settings (organisation consent, retention, minimum group size). Advisory only — no score.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  acknowledgeKpiNotice,
  computeKpis,
  flagKpiEvent,
  hrIndividual,
  hrKpis,
  kpiStatus,
  myKpiSources,
  myKpis,
  recordKpiConsent,
  restoreKpiEvent,
  teamKpis,
  teamMemberKpis,
  updateKpiSettings,
  withdrawKpiConsent,
} from '../../api/features.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const fmt = (m) => {
  if (m.status === 'not_observable') return 'Not observable';
  if (m.status === 'insufficient_data' || m.value === null) return 'Not enough data';
  if (m.unit === 'ratio') return `${Math.round(m.value * 100)}%`;
  if (m.unit === 'hours') return m.value >= 48 ? `${Math.round(m.value / 24)} days` : `${Math.round(m.value)} h`;
  return String(Math.round(m.value * 10) / 10);
};
const PROFILE = { work_pattern: 'Work pattern', role_tendency: 'Role tendency', reliability_band: 'Reliability band', growth_trend_4w: 'Trend (4 weeks)', growth_trend_12w: 'Trend (12 weeks)' };

function Advisory({ text }) {
  return <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">{text ?? 'These metrics are advisory context for a conversation. They are not a score and are never used for automated decisions.'}</p>;
}

function MetricsGrid({ data, periodDays, onSources }) {
  const rows = data.metrics.filter((m) => m.periodDays === periodDays);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((m) => (
        <div key={m.key} className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{m.label}</p>
          <p className={`mt-1 text-xl font-semibold ${m.status === 'ok' ? 'text-slate-900' : 'text-slate-400'}`}>{fmt(m)}</p>
          <p className="mt-1 text-xs text-slate-500">{m.description}</p>
          {m.numerator !== null && m.denominator !== null && m.status === 'ok' && <p className="text-xs text-slate-500">{m.numerator} of {m.denominator}</p>}
          {m.details?.reason && <p className="text-xs text-slate-500">{m.details.reason}</p>}
          {onSources && m.sourceCount > 0 && (
            <button type="button" className="mt-2 text-xs text-slate-700 underline-offset-2 hover:underline" onClick={() => onSources(m)}>
              {m.sourceCount} source event{m.sourceCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Profile({ data }) {
  if (!data.profile.length) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {data.profile.map((p) => (
        <li key={p.dimension} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <p className="text-xs text-slate-500">{PROFILE[p.dimension] ?? p.dimension}</p>
          <p className="font-medium capitalize">{p.value.replaceAll('_', ' ')}</p>
          {p.details?.comparedWith && <p className="text-[11px] text-slate-500">vs {p.details.comparedWith}</p>}
        </li>
      ))}
    </ul>
  );
}

export function MyKpiPage() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState(28);
  const [sources, setSources] = useState(null);
  const load = useCallback(() => myKpis().then(setD).catch(setError), []);
  useEffect(() => {
    load();
  }, [load]);
  if (error && !d) return <ErrorAlert error={error} />;
  if (!d) return <Loading />;
  const st = d.status;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">My work metrics</h1>
        <p className="mt-1 text-sm text-slate-500">You see your own data first, and every event behind it.</p>
      </div>
      <ErrorAlert error={error} />
      {!st.enabled && <EmptyState title="Work metrics are off">Your organisation has not enabled them{st.orgConsent ? '' : ' (no organisation consent is recorded)'}.</EmptyState>}
      {!st.acknowledged && (
        <Card title="Before anything is computed: the notice">
          <div className="space-y-3 text-sm">
            {st.notice.text.split('\n\n').map((p) => (
              <p key={p}>{p}</p>
            ))}
            <p className="font-medium">Never collected:</p>
            <ul className="list-disc pl-5">
              {st.neverCollected.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <Button onClick={() => acknowledgeKpiNotice().then(load).catch(setError)}>I have read this notice</Button>
            <p className="text-xs text-slate-500">Nothing is computed about you until you acknowledge it.</p>
          </div>
        </Card>
      )}
      {st.acknowledged && d.data && (
        <>
          <Advisory text={st.advisory} />
          {!d.data.periodEnd ? (
            <EmptyState title="No metrics yet">They are computed overnight.</EmptyState>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-500">Period ending {d.data.periodEnd}</span>
                <select aria-label="Period" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                  <option value={28}>Last 4 weeks</option>
                  <option value={84}>Last 12 weeks</option>
                </select>
              </div>
              <MetricsGrid data={d.data} periodDays={period} onSources={(m) => myKpiSources(m.key, m.periodDays).then((r) => setSources({ metric: m, list: r.sources })).catch(setError)} />
              <Card title="Work profile">
                <Profile data={d.data} />
              </Card>
            </>
          )}
          {sources && (
            <Card title={`Events behind “${sources.metric.label}”`} actions={<Button variant="link" onClick={() => setSources(null)}>Close</Button>}>
              <ul className="divide-y divide-slate-100 text-sm">
                {sources.list.map((s) => (
                  <li key={`${s.ref.type}${s.ref.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className={s.excluded ? 'text-slate-400 line-through' : ''}>{s.summary?.title ?? `${s.ref.type} ${s.ref.id}`}</span>
                    {!s.excluded && (
                      <button
                        type="button"
                        className="text-xs text-red-700 hover:underline"
                        onClick={() => {
                          const reason = window.prompt('Why is this not yours? (it is excluded at once)');
                          if (reason && reason.trim().length >= 3)
                            flagKpiEvent({ sourceType: s.ref.type, sourceId: s.ref.id, reason })
                              .then((r) => {
                                setD(r);
                                setSources(null);
                              })
                              .catch(setError);
                        }}
                      >
                        Not mine
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {d.corrections.length > 0 && (
            <Card title="Events you flagged">
              <ul className="space-y-1 text-sm">
                {d.corrections.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span>
                      {c.sourceType} #{c.sourceId}: {c.reason} <span className="text-xs text-slate-500">({c.status})</span>
                    </span>
                    {c.status === 'excluded' && (
                      <button type="button" className="text-xs hover:underline" onClick={() => restoreKpiEvent(c.id).then(setD).catch(setError)}>
                        Restore
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Who viewed my metrics">
            {d.accessLog.length === 0 ? (
              <p className="text-sm text-slate-500">Nobody yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.accessLog.map((l, i) => (
                  <li key={i}>
                    {formatDateTime(l.at)} — {l.viewer ?? 'someone'} ({l.scope.replaceAll('_', ' ')}){l.reason ? `: “${l.reason}”` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {st.access.teams.length > 0 && (
            <p className="text-sm">
              Your teams:{' '}
              {st.access.teams.map((t) => (
                <Link key={t.id} to={`/kpi/teams/${t.id}`} className="mr-3 underline">
                  {t.name}
                </Link>
              ))}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function TeamKpiPage() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [person, setPerson] = useState(null);
  useEffect(() => {
    teamKpis(id).then(setD).catch(setError);
  }, [id]);
  if (error && !d) return <ErrorAlert error={error.status === 403 ? 'Only the team lead can see this team’s metrics.' : error.code === 'KPI_DISABLED' ? 'Work metrics are off.' : error} />;
  if (!d) return <Loading />;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Team metrics: {d.team.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {d.membersIncluded} of {d.membersTotal} members take part{d.notIncluded ? ' (others have not acknowledged the notice)' : ''}. Each view is logged and shown to the person.
        </p>
      </div>
      <Advisory text={d.advisory} />
      <ErrorAlert error={error} />
      <Card title="Workload">
        {d.workload.length === 0 ? (
          <p className="text-sm text-slate-500">No data.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {d.workload.map((w) => (
              <li key={w.person.id} className="flex items-center gap-3">
                <button type="button" className="w-40 truncate text-left hover:underline" onClick={() => teamMemberKpis(id, w.person.id).then(setPerson).catch(setError)}>
                  {w.person.fullName}
                </button>
                <div className="h-2 flex-1 rounded bg-slate-100" aria-hidden="true">
                  <div className={`h-2 rounded ${w.aboveTeamMean ? 'bg-amber-500' : 'bg-slate-500'}`} style={{ width: `${Math.min(100, (w.load ?? 0) * 5)}%` }} />
                </div>
                <span className="w-28 text-right text-xs text-slate-600">
                  {w.load === null ? '—' : w.load.toFixed(1)} · {w.open} open{w.aboveTeamMean ? ' · high' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Blocked work">
          {d.blocked.length === 0 ? <p className="text-sm text-slate-500">Nothing blocked.</p> : <ul className="space-y-1 text-sm">{d.blocked.map((b) => <li key={b.id}>{b.title} <span className="text-xs text-slate-500">· {b.assignee}</span></li>)}</ul>}
        </Card>
        <Card title="Review contribution">
          <ul className="space-y-1 text-sm">
            {d.reviewContribution.map((r) => (
              <li key={r.person.id}>
                {r.person.fullName}: {r.status === 'ok' ? r.reviews : r.status === 'not_observable' ? 'not observable' : '—'}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Team averages">
        {d.aggregates ? (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(d.aggregates).map(([k, v]) => (
              <li key={k}>
                {k.replaceAll('_', ' ')}: {v.mean === null ? '—' : Math.round(v.mean * 100) / 100} <span className="text-xs text-slate-500">({v.people} people)</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">{d.aggregateNote}</p>
        )}
      </Card>
      {person && (
        <Card title={`${person.person.fullName} (logged view)`} actions={<Button variant="link" onClick={() => setPerson(null)}>Close</Button>}>
          {person.periodEnd ? <MetricsGrid data={person} periodDays={28} /> : <p className="text-sm text-slate-500">No metrics yet.</p>}
          <div className="mt-4">
            <Profile data={person} />
          </div>
        </Card>
      )}
    </div>
  );
}

export function HrKpiPage() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [drill, setDrill] = useState({ userId: '', reason: '' });
  const [person, setPerson] = useState(null);
  useEffect(() => {
    hrKpis().then(setD).catch(setError);
  }, []);
  if (error && !d) return <ErrorAlert error={error.status === 403 ? 'HR access is required.' : error.code === 'KPI_DISABLED' ? 'Work metrics are off.' : error} />;
  if (!d) return <Loading />;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Work metrics — organisation (HR)</h1>
        <p className="mt-1 text-sm text-slate-500">Aggregates only. {d.note}</p>
      </div>
      <Advisory />
      {d.groups.length === 0 && <EmptyState title="No groups large enough">{d.suppressed ? `${d.suppressed} group(s) are below the minimum size.` : 'No metrics yet.'}</EmptyState>}
      {d.groups.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Group</th>
                <th className="px-3 py-2">People</th>
                <th className="px-3 py-2">Reliability</th>
                <th className="px-3 py-2">Cycle time (h)</th>
                <th className="px-3 py-2">Load (median / max)</th>
                <th className="px-3 py-2">Rework</th>
              </tr>
            </thead>
            <tbody>
              {d.groups.map((g) => (
                <tr key={`${g.type}${g.id}`} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    {g.name} <span className="text-xs text-slate-500">{g.type}</span>
                  </td>
                  <td className="px-3 py-2">{g.people}</td>
                  <td className="px-3 py-2">{g.metrics.commitment_reliability.mean === null ? '—' : `${Math.round(g.metrics.commitment_reliability.mean * 100)}%`}{g.metrics.commitment_reliability.previousMean !== null && g.metrics.commitment_reliability.mean !== null ? ` (was ${Math.round(g.metrics.commitment_reliability.previousMean * 100)}%)` : ''}</td>
                  <td className="px-3 py-2">{g.metrics.cycle_time.mean === null ? '—' : Math.round(g.metrics.cycle_time.mean)}</td>
                  <td className="px-3 py-2">{g.workload ? `${g.workload.median.toFixed(1)} / ${g.workload.max.toFixed(1)}` : '—'}</td>
                  <td className="px-3 py-2">{g.metrics.rework_rate.mean === null ? '—' : `${Math.round(g.metrics.rework_rate.mean * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Card title="Individual view (requires a reason; logged; the person is notified)">
        <form
          className="grid gap-3 md:grid-cols-[10rem_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            hrIndividual(Number(drill.userId), drill.reason).then(setPerson).catch(setError);
          }}
        >
          <Field label="User id">
            <input className={inputClass} inputMode="numeric" required value={drill.userId} onChange={(e) => setDrill({ ...drill, userId: e.target.value })} />
          </Field>
          <Field label="Reason" hint="At least 10 characters. The person sees it.">
            <input className={inputClass} required minLength={10} maxLength={500} value={drill.reason} onChange={(e) => setDrill({ ...drill, reason: e.target.value })} />
          </Field>
          <div className="self-end">
            <Button type="submit">View</Button>
          </div>
        </form>
        <ErrorAlert error={error} className="mt-2" />
        {person && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium">{person.person.fullName}</p>
            {person.periodEnd ? <MetricsGrid data={person} periodDays={28} /> : <p className="text-sm text-slate-500">No metrics.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

export function KpiAdminPage() {
  const [st, setSt] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [statement, setStatement] = useState('');
  const [form, setForm] = useState(null);
  const load = () =>
    kpiStatus()
      .then((s) => {
        setSt(s);
        setForm({ retentionDays: s.retentionDays, minTeamSize: s.minTeamSize, noticeText: s.notice.text });
      })
      .catch(setError);
  useEffect(() => {
    load();
  }, []);
  const act = async (fn, msg) => {
    try {
      setSt(await fn());
      setNotice(msg);
      setError(null);
    } catch (err) {
      setError(err);
    }
  };
  if (!st) return error ? <ErrorAlert error={error} /> : <Loading />;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Work metrics settings</h1>
        <p className="mt-1 text-sm text-slate-500">Off until the organisation’s consent is recorded and the setting is on; each employee must also acknowledge the notice.</p>
      </div>
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>
      <Card title="Organisation consent">
        {st.orgConsent ? (
          <div className="space-y-2 text-sm">
            <p>
              Recorded {formatDateTime(st.orgConsent.at)}: “{st.orgConsent.statement}”
            </p>
            <Button variant="danger" onClick={() => window.confirm('Withdraw consent? Tracking stops at once.') && act(withdrawKpiConsent, 'Consent withdrawn; tracking is off.')}>
              Withdraw consent
            </Button>
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => recordKpiConsent(statement), 'Consent recorded.');
            }}
          >
            <Field label="Consent statement" hint="e.g. the works-council or legal sign-off, with a reference. Required before enabling.">
              <textarea className={inputClass} rows={3} minLength={20} required value={statement} onChange={(e) => setStatement(e.target.value)} />
            </Field>
            <Button type="submit">Record consent</Button>
          </form>
        )}
      </Card>
      <Card title="Settings">
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={st.enabled} disabled={!st.orgConsent} onChange={(e) => act(() => updateKpiSettings({ enabled: e.target.checked }), e.target.checked ? 'Work metrics enabled.' : 'Work metrics disabled.')} />
            Work metrics enabled
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Retention (days)">
              <input type="number" min={30} max={3650} className={inputClass} value={form.retentionDays} onChange={(e) => setForm({ ...form, retentionDays: Number(e.target.value) })} />
            </Field>
            <Field label="Minimum group size for aggregates">
              <input type="number" min={3} max={50} className={inputClass} value={form.minTeamSize} onChange={(e) => setForm({ ...form, minTeamSize: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Employee notice" hint="Changing it asks everyone to acknowledge again before more is computed.">
            <textarea className={inputClass} rows={8} value={form.noticeText} onChange={(e) => setForm({ ...form, noticeText: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act(() => updateKpiSettings(form), 'Settings saved.')}>Save</Button>
            <Button variant="secondary" onClick={() => computeKpis().then(() => setNotice('Computation queued; it runs in the worker.')).catch(setError)}>
              Compute now
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
