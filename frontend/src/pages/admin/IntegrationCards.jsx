// Dashboard cards for Figma and Microsoft Teams with an honest state: Connected, Syncing, Error,
// Disconnected, or Configuration required. The Teams card makes the DEVELOPMENT MOCK obvious.
import { RefreshCw, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { disconnect, startConnect, syncNow } from '../../api/integrations.js';
import { getOverview, resetTeamsMock, syncTeamsMock } from '../../api/integrationOverview.js';
import { IntegrationIcon } from '../../components/icons.jsx';
import { Badge, Button, ButtonLink, ErrorAlert, MiniStat, SuccessAlert } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const STATE = {
  connected: { label: 'Connected', tone: 'success' },
  syncing: { label: 'Syncing', tone: 'info', pulse: true },
  error: { label: 'Error', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'muted' },
  not_configured: { label: 'Configuration required', tone: 'warning' },
};

export function FigmaLogo() {
  return <IntegrationIcon provider="figma" size={40} title="Figma logo" />;
}
export function TeamsLogo() {
  return <IntegrationIcon provider="microsoft_teams" size={40} title="Microsoft Teams logo" />;
}

const StateBadge = ({ state }) => (
  <Badge tone={STATE[state]?.tone ?? 'neutral'} dot pulse={STATE[state]?.pulse}>
    {STATE[state]?.label ?? state}
  </Badge>
);
const Stat = MiniStat;
const cardClass = 'flex flex-col rounded-xl border bg-white p-5';
const dlClass = 'mt-4 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[8rem_1fr]';

export function IntegrationCards({ onConnect, onLoaded }) {
  const [cards, setCards] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  const load = useCallback(
    () =>
      getOverview()
        .then((d) => {
          setCards(d.cards);
          onLoaded?.(d.cards);
        })
        .catch(setError),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
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
    <section aria-label="Figma integration" className={`${cardClass} border-slate-200`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <FigmaLogo />
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Figma</h2>
            <p className="mt-0.5 text-xs text-slate-500">Design files, versions and comments (OAuth 2.0)</p>
          </div>
        </div>
        <StateBadge state={c.state} />
      </div>
      {c.state === 'not_configured' && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900">
          <p className="font-medium">Figma is not configured on the server: {c.problem}.</p>
          <p className="mt-1">
            Create a <strong>private</strong> OAuth app in Figma (Developers → Create a new app), add the redirect URL, then set <code>FIGMA_CLIENT_ID</code>, <code>FIGMA_CLIENT_SECRET</code>, <code>FIGMA_TEAM_ID</code> and <code>FIGMA_REDIRECT_URI</code> in <code>backend/.env</code> and restart. Steps: <code>{c.setupDoc}</code>.
          </p>
        </div>
      )}
      {c.state === 'disconnected' && <p className="mt-4 text-sm text-slate-600">Not connected. Connect with a Figma account that is a member of the configured team.</p>}
      {connected && (
        <>
          <dl className={dlClass}>
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
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {c.state === 'disconnected' && (
          <Button disabled={Boolean(busy)} onClick={() => onConnect('figma')}>
            Connect Figma
          </Button>
        )}
        {connected && (
          <>
            <Button variant="secondary" icon={RefreshCw} disabled={Boolean(busy) || c.state === 'syncing'} onClick={() => run('figma-sync', () => syncNow(c.connection.id), (r) => (r.queued ? `Figma sync queued for ${r.queued} project(s).` : 'Nothing to sync: enable a project first.'))}>
              {c.state === 'syncing' ? 'Syncing…' : 'Sync now'}
            </Button>
            <ButtonLink to={`/admin/integrations/${c.connection.id}`} icon={Settings2}>
              Projects and details
            </ButtonLink>
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
    <section aria-label="Microsoft Teams integration" className={`${cardClass} ${c.mock ? 'border-violet-300' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <TeamsLogo />
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Microsoft Teams</h2>
            <p className="mt-0.5 text-xs text-slate-500">Channels, meetings and transcripts</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <StateBadge state={c.state} />
          {c.mock && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">Development mock</span>}
        </div>
      </div>
      {c.mock && (
        <p className="mt-4 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          Development mock connection (TEAMS_INTEGRATION_MODE=mock): fictional data, no Microsoft account is connected or verified.
        </p>
      )}
      {c.state === 'not_configured' && <p className="mt-4 text-sm text-amber-800">Not configured on the server: {c.problem}.</p>}
      {c.mock && (active || c.state === 'disconnected') && (
        <>
          <dl className={dlClass}>
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
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {c.mock ? (
          <>
            <ButtonLink to="/admin/integrations/teams-mock">View Teams</ButtonLink>
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
