// Admin settings for action intelligence: which connected sources are analysed for action items,
// and the organisation's follow-up policy (reminders, escalations, and whether automated e-mail
// is allowed at all).
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { actionSettings, saveFollowups, saveSourceSettings, scanSourcesNow } from '../../api/actions.js';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const NumberField = ({ label, value, onChange, hint, min = 0, max = 60 }) => (
  <Field label={label} hint={hint}>
    <input type="number" min={min} max={max} className={inputClass} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </Field>
);

export function ActionSettingsPage() {
  const [s, setS] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const load = () =>
    actionSettings()
      .then((d) => {
        setS(d);
        setF(d.followups);
      })
      .catch(setError);
  useEffect(() => {
    load();
  }, []);
  if (!s) return error ? <ErrorAlert error={error} /> : <Loading />;
  const src = s.sources.settings;
  const run = async (fn, msg) => {
    setError(null);
    setNotice('');
    try {
      const r = await fn();
      setNotice(typeof msg === 'function' ? msg(r) : msg);
      await load();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="space-y-5">
      <Link to="/actions" className="text-sm text-slate-500 hover:underline">
        ← Action Center
      </Link>
      <h1 className="text-2xl font-semibold">Action intelligence settings</h1>
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>

      <Card
        title="Sources analysed for action items"
        actions={
          <Button variant="secondary" onClick={() => run(scanSourcesNow, (r) => `Analysed ${r.result.threads} thread(s): ${r.result.created} new item(s), ${r.result.linked} merged into existing items.`)}>
            Analyse now
          </Button>
        }
      >
        {!s.sources.configured && <p className="mb-3 text-sm text-amber-800">The AI service (WorkAPI) is not configured, so synced records are not analysed.</p>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={src.enabled} onChange={(e) => run(() => saveSourceSettings({ enabled: e.target.checked }), 'Saved.')} /> Find action items in synced records (they are always reviewed before anyone is notified)
        </label>
        <table className="mt-3 min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Source</th>
              <th className="py-1">Analysed</th>
              <th className="py-1">Items found</th>
              <th className="py-1">Last run</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {s.sources.sources.map((x) => {
              const done = x.scans.filter((c) => c.status === 'analysed');
              const last = x.scans.map((c) => c.lastAnalysedAt).filter(Boolean).sort().at(-1);
              return (
                <tr key={x.provider}>
                  <td className="py-2">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={src.providers?.[x.provider] !== false} onChange={(e) => run(() => saveSourceSettings({ providers: { [x.provider]: e.target.checked } }), 'Saved.')} /> {x.label}
                    </label>
                  </td>
                  <td className="py-2">{x.scans.reduce((n, c) => n + c.records, 0)} records</td>
                  <td className="py-2">{done.reduce((n, c) => n + c.created, 0)} new · {done.reduce((n, c) => n + c.linked, 0)} merged</td>
                  <td className="py-2 text-xs text-slate-500">{last ? formatDateTime(last) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Follow-up policy">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField label="Remind owners (days before due)" value={f.reminderDaysBefore} max={14} onChange={(v) => setF({ ...f, reminderDaysBefore: v })} />
          <NumberField label="Escalate overdue after (days)" value={f.overdueEscalationDays} max={30} onChange={(v) => setF({ ...f, overdueEscalationDays: v })} />
          <NumberField label="Flag no progress after (days)" value={f.noProgressDays} min={1} onChange={(v) => setF({ ...f, noProgressDays: v })} />
          <NumberField label="Escalate blockers after (days)" value={f.blockerEscalationDays} max={30} onChange={(v) => setF({ ...f, blockerEscalationDays: v })} />
        </div>
        <div className="mt-3 space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Automated follow-up is on
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.channels.inApp !== false} onChange={(e) => setF({ ...f, channels: { ...f.channels, inApp: e.target.checked } })} /> In-app notifications (each person can still turn kinds off)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(f.channels.email)} onChange={(e) => setF({ ...f, channels: { ...f.channels, email: e.target.checked } })} /> Also send reminder and escalation e-mails
          </label>
          {f.channels.email && <p className="rounded-md bg-amber-50 px-2 py-1 text-amber-900">With this on, WorkAgent sends these e-mails without asking each time. They are recorded as plans approved by this policy on the Approvals page, and only go to people in the directory.</p>}
        </div>
        <Button className="mt-3" onClick={() => run(() => saveFollowups(f), 'Follow-up policy saved.')}>
          Save policy
        </Button>
      </Card>
    </div>
  );
}
