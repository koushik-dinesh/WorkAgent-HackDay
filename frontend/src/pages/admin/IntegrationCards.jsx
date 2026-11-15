// Dashboard cards for Figma and Microsoft Teams with an honest state: Connected, Syncing, Error,
// Disconnected, or Configuration required. The Teams card makes the DEVELOPMENT MOCK obvious.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { disconnect, startConnect, syncNow } from '../../api/integrations.js';
import { getOverview, resetTeamsMock, syncTeamsMock } from '../../api/integrationOverview.js';
import { Button, ErrorAlert, SuccessAlert } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const STATE = {
  connected: { label: 'Connected', cls: 'bg-emerald-100 text-emerald-800' },
  syncing: { label: 'Syncing', cls: 'bg-sky-100 text-sky-800' },
  error: { label: 'Error', cls: 'bg-red-100 text-red-700' },
  disconnected: { label: 'Disconnected', cls: 'bg-slate-100 text-slate-600' },
  not_configured: { label: 'Configuration required', cls: 'bg-amber-100 text-amber-800' },
};

export function FigmaLogo() {
  return (
    <svg viewBox="0 0 38 57" width="22" height="33" aria-label="Figma logo" role="img">
      <path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" />
      <path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
      <path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" />
      <path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
      <path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" />
    </svg>
  );
}
export function TeamsLogo() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-label="Microsoft Teams logo" role="img">
      <rect x="2" y="6" width="20" height="20" rx="3" fill="#5059c9" />
      <path fill="#fff" d="M7 11h10v2.4h-3.7V21h-2.6v-7.6H7z" />
      <circle cx="25" cy="10" r="3.5" fill="#7b83eb" />
      <rect x="21" y="15" width="9" height="10" rx="3" fill="#7b83eb" />
    </svg>
  );
}

const Badge = ({ state }) => <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATE[state]?.cls}`}>{STATE[state]?.label ?? state}</span>;
const Stat = ({ label, value }) => (
  <div className="rounded-lg border border-slate-200 px-3 py-2">
    <dt className="text-[11px] uppercase text-slate-500">{label}</dt>
    <dd className="text-lg font-semibold text-slate-900">{value ?? 0}</dd>
  </div>
);

export function IntegrationCards({ onConnect }) {
  const [cards, setCards] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => getOverview().then((d) => setCards(d.cards)).catch(setError), []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(key, fn, message) {
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      const r = await fn();
      setNotice(typeof message === 'function' ? message(r) : message);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!cards) return error ? <ErrorAlert error={`Could not load the integration summary: ${error.message}`} /> : null;
  const figma = cards.find((c) => c.provider === 'figma');
  const teams = cards.find((c) => c.provider === 'microsoft_teams');
  return (
    <div className="space-y-3">
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>
      <div className="grid gap-4 lg:grid-cols-2">
        {figma && <FigmaCard c={figma} busy={busy} run={run} onConnect={onConnect} />}
        {teams && <TeamsCard c={teams} busy={busy} run={run} onConnect={onConnect} />}
      </div>
    </div>
  );
}

function FigmaCard({ c, busy, run, onConnect }) {
  const f = c.figma ?? {};
  const connected = ['connected', 'syncing', 'error'].includes(c.state);
  return (
    <section aria-label="Figma integration" className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <FigmaLogo />
          <div>
            <h2 className="font-semibold text-slate-900">Figma</h2>
            <p className="text-xs text-slate-500">Design files, versions and comments (OAuth 2.0)</p>
          </div>
        </div>
        <Badge state={c.state} />
      </div>
      {c.state === 'not_configured' && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Figma is not configured on the server: {c.problem}.</p>
          <p className="mt-1">
            Create a <strong>private</strong> OAuth app in Figma (Developers → Create a new app), add the redirect URL, then set <code>FIGMA_CLIENT_ID</code>, <code>FIGMA_CLIENT_SECRET</code>, <code>FIGMA_TEAM_ID</code> and <code>FIGMA_REDIRECT_URI</code> in <code>backend/.env</code> and restart. Steps: <code>{c.setupDoc}</code>.
          </p>
        </div>
      )}
      {c.state === 'disconnected' && <p className="mt-4 text-sm text-slate-600">Not connected. Connect with a Figma account that is a member of the configured team.</p>}
      {connected && (
        <>
          <dl className="mt-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-slate-500">Account</dt>
            <dd>
              {f.account ?? '—'}
              {f.accountHandle && f.accountHandle !== f.account ? ` (${f.accountHandle})` : ''}
            </dd>
            <dt className="text-slate-500">Teams</dt>
            <dd>{f.teams?.map((t) => t.name).join(', ') || '—'}</dd>
            <dt className="text-slate-500">Last sync</dt>
            <dd>{c.connection?.lastSyncSucceededAt ? formatDateTime(c.connection.lastSyncSucceededAt) : 'Not synced yet'}</dd>
          </dl>
          {c.state === 'error' && c.connection?.lastErrorMessage && <p className="mt-2 text-sm text-red-700">{c.connection.lastErrorMessage}</p>}
          <dl className="mt-3 grid grid-cols-4 gap-2">
            <Stat label="Projects" value={f.projects} />
            <Stat label="Files" value={f.files} />
            <Stat label="Versions" value={f.versions} />
            <Stat label="Comments" value={f.comments} />
          </dl>
          {f.projectsEnabled === 0 && <p className="mt-2 text-xs text-amber-700">No project is enabled yet: open the details and enable the projects to import.</p>}
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {c.state === 'disconnected' && (
          <Button disabled={Boolean(busy)} onClick={() => onConnect('figma')}>
            Connect Figma
          </Button>
        )}
        {connected && (
          <>
            <Button variant="secondary" disabled={Boolean(busy) || c.state === 'syncing'} onClick={() => run('figma-sync', () => syncNow(c.connection.id), (r) => (r.queued ? `Figma sync queued for ${r.queued} project(s).` : 'Nothing to sync: enable a project first.'))}>
              {c.state === 'syncing' ? 'Syncing…' : 'Sync now'}
            </Button>
            <Link to={`/admin/integrations/${c.connection.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Projects and details
            </Link>
            <Button variant="danger" disabled={Boolean(busy)} onClick={() => window.confirm('Disconnect Figma? Imported data is kept; the stored tokens are deleted.') && run('figma-disc', () => disconnect(c.connection.id), 'Figma disconnected. Imported data was kept.')}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function TeamsCard({ c, busy, run, onConnect }) {
  const t = c.teams;
  const counts = t?.counts ?? {};
  const active = ['connected', 'syncing', 'error'].includes(c.state);
  return (
    <section aria-label="Microsoft Teams integration" className={`rounded-xl border bg-white p-5 ${c.mock ? 'border-violet-300' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <TeamsLogo />
          <div>
            <h2 className="font-semibold text-slate-900">Microsoft Teams</h2>
            <p className="text-xs text-slate-500">Channels, meetings and transcripts</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge state={c.state} />
          {c.mock && <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">Development mock</span>}
        </div>
      </div>
      {c.mock && (
        <p className="mt-3 rounded-md bg-violet-50 px-3 py-2 text-xs text-violet-900">
          Development mock connection (TEAMS_INTEGRATION_MODE=mock): fictional data, no Microsoft account is connected or verified.
        </p>
      )}
      {c.state === 'not_configured' && <p className="mt-4 text-sm text-amber-800">Not configured on the server: {c.problem}.</p>}
      {c.mock && (active || c.state === 'disconnected') && (
        <>
          <dl className="mt-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-slate-500">Status</dt>
            <dd className="font-semibold">{c.state === 'connected' ? 'CONNECTED' : c.state.toUpperCase()}</dd>
            <dt className="text-slate-500">Mode</dt>
            <dd className="font-semibold">DEVELOPMENT MOCK</dd>
            <dt className="text-slate-500">Account</dt>
            <dd>{t?.account ?? 'demo.user@example.com'}</dd>
            <dt className="text-slate-500">Organisation</dt>
            <dd>{t?.organisation ?? 'Violin Technologies'}</dd>
            <dt className="text-slate-500">Last sync</dt>
            <dd>{c.connection?.lastSyncSucceededAt ? formatDateTime(c.connection.lastSyncSucceededAt) : 'Not synced yet'}</dd>
          </dl>
          <dl className="mt-3 grid grid-cols-4 gap-2">
            <Stat label="Teams" value={counts.teams} />
            <Stat label="Channels" value={counts.channels} />
            <Stat label="Meetings" value={counts.meetings} />
            <Stat label="Messages" value={counts.messages} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            {counts.employees ?? 0} fictional employees · {counts.transcriptsImported ?? 0} transcripts imported · {counts.replies ?? 0} replies
          </p>
        </>
      )}
      {!c.mock && c.state === 'disconnected' && <p className="mt-4 text-sm text-slate-600">Not connected. A real connection needs a Microsoft Entra app with admin consent (runbook §12).</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {c.mock ? (
          <>
            <Link to="/admin/integrations/teams-mock" className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              View Teams
            </Link>
            <Button disabled={Boolean(busy)} onClick={() => run('mock-sync', syncTeamsMock, (r) => `Mock data synced: ${r.counts.teams} teams, ${r.counts.channels} channels, ${r.counts.meetings} meetings, ${r.counts.messages} messages.`)}>
              {busy === 'mock-sync' ? 'Syncing…' : 'Sync Mock Data'}
            </Button>
            <Button variant="danger" disabled={Boolean(busy)} onClick={() => window.confirm('Delete all Violin Technologies mock data? Only records created by the mock are deleted.') && run('mock-reset', resetTeamsMock, (r) => `Mock data reset: ${r.deleted.records} records, ${r.deleted.meetings} meetings and ${r.deleted.users} mock employees deleted.`)}>
              Reset Mock Data
            </Button>
            {active && (
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => run('mock-disc', () => disconnect(c.connection.id), 'Mock connection disconnected. Its data was kept; use Sync Mock Data to reconnect.')}>
                Disconnect
              </Button>
            )}
          </>
        ) : (
          c.state === 'disconnected' && (
            <Button disabled={Boolean(busy) || !c.available} onClick={() => onConnect('microsoft_teams')}>
              Connect Microsoft Teams
            </Button>
          )
        )}
      </div>
    </section>
  );
}
