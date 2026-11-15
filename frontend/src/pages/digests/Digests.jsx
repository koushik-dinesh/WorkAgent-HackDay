// Weekly digests. The dashboard copy is the canonical one: every figure is computed by WorkAgent,
// every item links to its source, and the AI narrative (when present) only restates those figures.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { digestPreferences, digestSettings, generateDigest, getDigest, listDigests, saveDigestPreferences, saveDigestSettings } from '../../api/features.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const AUDIENCE = { manager: 'Team', hr: 'HR', executive: 'Executive' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function DigestsPage() {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    listDigests().then((d) => setList(d.digests)).catch(setError);
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Weekly digests</h1>
        <p className="mt-1 text-sm text-slate-500">What shipped, slipped and needs attention — computed from your work graph every week.</p>
      </div>
      <ErrorAlert error={error} />
      {!list && !error && <Loading />}
      {list?.length === 0 && <EmptyState title="No digests yet">Team leads, HR and admins receive a digest after each weekly cut-off.</EmptyState>}
      {list?.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <Link to={`/digests/${d.id}`} className={`hover:underline ${d.read ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>
                {d.scopeName}
              </Link>
              <span className="text-xs text-slate-500">
                {AUDIENCE[d.audience]} · week to {formatDateTime(d.periodEnd)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <PreferencesCard />
      {user.role === 'admin' && <DigestAdmin />}
    </div>
  );
}

function PreferencesCard() {
  const [p, setP] = useState(null);
  const [sections, setSections] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    digestPreferences()
      .then((d) => {
        setP(d.preferences);
        setSections(d.sections);
      })
      .catch(setError);
  }, []);
  if (!p) return null;
  const save = (next) =>
    saveDigestPreferences(next)
      .then((d) => {
        setP(d.preferences);
        setNotice('Preferences saved.');
      })
      .catch(setError);
  return (
    <Card title="My digest preferences">
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>
      <p className="text-sm text-slate-600">Sections to show (your choice only; others are unaffected):</p>
      <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        {sections.map((s) => (
          <li key={s.key}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!p.suppressedSections.includes(s.key)} onChange={(e) => save({ suppressedSections: e.target.checked ? p.suppressedSections.filter((x) => x !== s.key) : [...p.suppressedSections, s.key] })} />
              {s.label}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={p.email} onChange={(e) => save({ email: e.target.checked })} /> E-mail me a copy
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={p.teams} onChange={(e) => save({ teams: e.target.checked })} /> Post my team’s summary to Teams
        </label>
      </div>
    </Card>
  );
}

function DigestAdmin() {
  const [s, setS] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    digestSettings().then((d) => setS(d.settings)).catch(setError);
  }, []);
  if (!s) return null;
  const save = (patch) =>
    saveDigestSettings(patch)
      .then((d) => {
        setS(d.settings);
        setNotice('Schedule saved.');
      })
      .catch(setError);
  return (
    <Card title="Schedule (admin)">
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>
      <div className="grid gap-4 md:grid-cols-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Enabled
        </label>
        <Field label="Day">
          <select className={inputClass} value={s.weekday} onChange={(e) => save({ weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Hour">
          <input type="number" min={0} max={23} className={inputClass} value={s.hour} onChange={(e) => save({ hour: Number(e.target.value) })} />
        </Field>
        <Field label="Time zone">
          <input className={inputClass} defaultValue={s.timeZone} onBlur={(e) => e.target.value !== s.timeZone && save({ timeZone: e.target.value })} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        {Object.keys(AUDIENCE).map((a) => (
          <label key={a} className="flex items-center gap-2">
            <input type="checkbox" checked={s.audiences[a]} onChange={(e) => save({ audiences: { ...s.audiences, [a]: e.target.checked } })} /> {AUDIENCE[a]} digests
          </label>
        ))}
      </div>
      <Button className="mt-3" variant="secondary" onClick={() => generateDigest().then((r) => setNotice(`Generation queued for the week to ${formatDateTime(r.periodEnd)}.`)).catch(setError)}>
        Generate now
      </Button>
    </Card>
  );
}

function ItemRow({ it }) {
  const label = it.team ? `${it.team}: ${it.count}` : `${it.key ? `${it.key} ` : ''}${it.title ?? ''}`;
  const extra = [
    it.owner && `owner ${it.owner}`,
    it.daysOverdue !== undefined && `${it.daysOverdue} days overdue`,
    it.blockedDays !== undefined && it.blockedDays !== null && `blocked ${it.blockedDays} days`,
    it.dueDate && it.daysOverdue === undefined && `due ${it.dueDate}`,
    it.promisedIn && `promised in “${it.promisedIn}”`,
    it.meeting && `in “${it.meeting}”`,
    it.reason,
    it.overdue !== undefined && `${it.overdue} overdue of ${it.open} (${it.overdueShare}%)`,
  ].filter(Boolean);
  return (
    <li className="py-1.5">
      {it.ref?.href ? (
        <Link to={it.ref.href} className="hover:underline">
          {label}
        </Link>
      ) : (
        label
      )}
      {extra.length > 0 && <span className="ml-1 text-xs text-slate-500">— {extra.join(' · ')}</span>}
    </li>
  );
}

export function DigestDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    getDigest(id).then(setD).catch(setError);
  }, [id]);
  if (error) return <ErrorAlert error={error.status === 404 ? 'Digest not found.' : error} />;
  if (!d) return <Loading />;
  const c = d.counts;
  return (
    <div className="space-y-6">
      <div>
        <Link to="/digests" className="text-sm text-slate-600 hover:underline">
          ← Weekly digests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{d.digest.scopeName}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {formatDateTime(d.digest.periodStart)} – {formatDateTime(d.digest.periodEnd)} · {AUDIENCE[d.digest.audience]} digest
        </p>
      </div>
      {d.digest.headline && <p className="rounded-md bg-slate-100 px-4 py-3 text-base">{d.digest.headline}</p>}
      {d.digest.narrativeNote && <p className="text-xs text-slate-500">{d.digest.narrativeNote}</p>}
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Shipped', c.shipped],
          ['Slipped', c.slipped],
          ['Blockers', c.blockers],
          ['At risk', c.commitmentsAtRisk],
          ['Decisions', c.decisions],
          ['On time', c.onTimeShare === null || c.onTimeShare === undefined ? '—' : `${c.onTimeShare}%`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <dt className="text-xs uppercase text-slate-500">{k}</dt>
            <dd className="text-xl font-semibold">{v ?? 0}</dd>
          </div>
        ))}
      </dl>
      {d.sections.map((s) => (
        <Card key={s.key} title={s.label}>
          {s.narrative && <p className="mb-2 text-sm text-slate-700">{s.narrative}</p>}
          {s.key === 'team_load' ? (
            <TeamLoad load={s.items} />
          ) : Array.isArray(s.items) && s.items.length ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {s.items.map((it, i) => (
                <ItemRow key={i} it={it} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Nothing this week.</p>
          )}
        </Card>
      ))}
      {d.suppressed.length > 0 && <p className="text-xs text-slate-500">{d.suppressed.length} section(s) hidden by your preferences.</p>}
      {d.deliveries.length > 0 && (
        <Card title="Delivery (admin)">
          <ul className="space-y-1 text-sm">
            {d.deliveries.map((r) => (
              <li key={r.userId}>
                {r.fullName}: e-mail {r.email}
                {r.emailError ? ` (${r.emailError})` : ''}, Teams {r.teams}
                {r.teamsError ? ` (${r.teamsError})` : ''}, {r.read ? 'read' : 'unread'}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TeamLoad({ load }) {
  if (!load?.available) return <p className="text-sm text-slate-500">Not available: {load?.reason ?? 'work metrics are off'}.</p>;
  if (load.aggregated) return load.teams.length ? <ul className="text-sm">{load.teams.map((t) => <li key={t.team}>{t.team}: mean load {t.teamMean ?? '—'}, {t.overloaded} above capacity ({t.people} people)</li>)}</ul> : <p className="text-sm text-slate-500">{load.note}</p>;
  return (
    <ul className="text-sm">
      {load.people.map((p) => (
        <li key={p.owner}>
          {p.owner}: load {p.loadIndex} ({p.openItems} open){p.overloaded ? ' — above team capacity' : ''}
        </li>
      ))}
      <li className="text-xs text-slate-500">Team mean {load.teamMean ?? '—'}</li>
    </ul>
  );
}
