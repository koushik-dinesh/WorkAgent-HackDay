import { ChevronRight, Plug, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listConnections, listIdentities, listProviders, matchIdentity, startConnect } from '../../api/integrations.js';
import { listUsers } from '../../api/users.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { IntegrationIcon } from '../../components/icons.jsx';
import { Button, ButtonLink, Card, ErrorAlert, Loading, PageHeader, SectionHeader, inputClass } from '../../components/ui.jsx';
import { formatDateTime, timeAgo } from '../../utils/format.js';
import { IntegrationCards } from './IntegrationCards.jsx';
import { VexaCard } from './VexaCard.jsx';
import { CONNECTION_STATUS, HEALTH } from './integrationLabels.js';

// What each application brings into WorkAgent (shown on its card), and how the catalogue is grouped.
const DESCRIPTION = {
  github: 'Repositories, issues, pull requests, reviews and commits.',
  jira: 'Projects, issues, comments and status changes.',
  google_calendar: 'Calendar events and Meet links, used to find meetings to transcribe.',
  outlook: 'Mail and calendar events from Microsoft 365.',
  microsoft_teams: 'Channels, meetings and transcripts.',
  figma: 'Design files, versions and comments.',
};
const CATEGORIES = [
  ['Engineering', ['github', 'jira']],
  ['Calendar and e-mail', ['google_calendar', 'outlook']],
  ['Communication', ['microsoft_teams']],
  ['Design', ['figma']],
];

/** Where "Connect" sends the browser. Overridable in tests (jsdom can't navigate). */
export const redirectTo = { go: (url) => window.location.assign(url) };

export function IntegrationsPage() {
  const [providers, setProviders] = useState(null);
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [overviewCards, setOverviewCards] = useState([]);

  useEffect(() => {
    Promise.all([listProviders(), listConnections()])
      .then(([p, c]) => {
        setProviders(p.providers);
        setConnections(c.connections);
      })
      .catch(setError);
  }, []);

  async function connect(providerId) {
    if (connecting) return;
    setConnecting(providerId);
    setError(null);
    try {
      const { redirectUrl } = await startConnect(providerId);
      redirectTo.go(redirectUrl);
    } catch (err) {
      setError(err);
      setConnecting(null);
    }
  }

  // Providers that have their own detailed card above are not repeated in the catalogue.
  const featured = new Set(overviewCards.map((c) => c.provider));
  const catalogue = (providers ?? []).filter((p) => !featured.has(p.id));
  const groups = CATEGORIES.map(([name, ids]) => [name, catalogue.filter((p) => ids.includes(p.id))]);
  const known = new Set(CATEGORIES.flatMap(([, ids]) => ids));
  const other = catalogue.filter((p) => !known.has(p.id));
  if (other.length) groups.push(['Other', other]);

  return (
    <div className="space-y-8">
      <PageHeader title="Integrations" description="Connect the applications your teams work in. Nothing is synced until you choose which repositories or projects to include." />
      <ErrorAlert error={error} />

      <VexaCard />

      <IntegrationCards onConnect={connect} onLoaded={setOverviewCards} />

      <section className="space-y-4" aria-label="Available applications">
        <SectionHeader title="Available applications" description="Each connection uses the provider’s own sign-in; WorkAgent never sees a password." />
        {!providers && !error && <Loading />}
        {providers?.length === 0 && <p className="text-sm text-slate-500">No integrations are installed on this server yet.</p>}
        {groups
          .filter(([, list]) => list.length > 0)
          .map(([name, list]) => (
            <div key={name}>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-400">{name}</h3>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((p) => {
                  const mine = (connections ?? []).filter((c) => c.provider === p.id && c.status !== 'disconnected');
                  const lastSync = mine.map((c) => c.lastSyncSucceededAt).filter(Boolean).sort().at(-1);
                  return (
                    <li key={p.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 transition-colors duration-150 hover:border-slate-300">
                      <div className="flex items-start gap-3">
                        <IntegrationIcon provider={p.id} size={38} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900">{p.displayName}</p>
                          {DESCRIPTION[p.id] && <p className="mt-0.5 text-xs text-slate-500">{DESCRIPTION[p.id]}</p>}
                        </div>
                      </div>
                      <div className="mt-3 space-y-1 text-xs">
                        {!p.available && <p className="text-amber-700">Not configured on the server: {p.problem}</p>}
                        {p.available && (
                          <p className="flex items-center gap-1.5 text-slate-500">
                            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${mine.length ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                            {mine.length ? `${mine.length} connection${mine.length === 1 ? '' : 's'}${lastSync ? ` · last synced ${timeAgo(lastSync)}` : ' · not synced yet'}` : 'No connection yet'}
                          </p>
                        )}
                        {p.webhookUrl && (
                          <p className="break-all text-slate-500">
                            Webhook URL: <code>{p.webhookUrl}</code>
                          </p>
                        )}
                      </div>
                      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                        <Button variant={mine.length ? 'secondary' : 'primary'} size="sm" icon={Plug} onClick={() => connect(p.id)} disabled={!p.available || Boolean(connecting)}>
                          {connecting === p.id ? 'Opening…' : `Connect ${p.displayName}`}
                        </Button>
                        {mine.length > 0 && (
                          <ButtonLink to={`/admin/integrations/${mine[0].id}`} variant="ghost" size="sm" icon={Settings2}>
                            Configure
                          </ButtonLink>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
      </section>

      {connections?.length === 0 && <EmptyState title="No connections yet" icon={Plug}>Connect an application above to start.</EmptyState>}
      {connections?.length > 0 && (
        <Card title="Connections" padded={false}>
          <ul className="divide-y divide-slate-100">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors duration-150 hover:bg-slate-50" aria-label={c.displayName}>
                <div className="flex min-w-0 items-center gap-3">
                  <IntegrationIcon provider={c.provider} size={32} />
                  <div className="min-w-0">
                    <Link to={`/admin/integrations/${c.id}`} className="text-sm font-medium text-slate-900 hover:underline">
                      {c.displayName}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {c.provider} · {c.accountLogin ?? c.externalAccountId} · last synced {formatDateTime(c.lastSyncSucceededAt)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {!c.isEnabled && c.status !== 'disconnected' && <span className="text-slate-500">Paused</span>}
                  <span className={`font-medium ${HEALTH[c.health]?.cls}`}>{HEALTH[c.health]?.label}</span>
                  <span className={`rounded-full px-2 py-0.5 font-medium ${CONNECTION_STATUS[c.status]?.cls}`}>{CONNECTION_STATUS[c.status]?.label}</span>
                  <ChevronRight size={14} aria-hidden="true" className="text-slate-300" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {connections?.length > 0 && <PeopleCard />}
    </div>
  );
}

/**
 * People from connected applications (e.g. GitHub accounts) and the WorkAgent user each one is.
 * Matching is manual: logins and names are never matched automatically (only a verified email
 * from the provider is), and a manual choice is never overwritten by a sync.
 */
function PeopleCard() {
  const [identities, setIdentities] = useState(null);
  const [users, setUsers] = useState([]);
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    listIdentities({ unmatched: onlyUnmatched })
      .then((d) => setIdentities(d.identities))
      .catch(setError);
  }, [onlyUnmatched]);
  useEffect(() => {
    listUsers({ includeInactive: false })
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, []);

  async function match(identity, userId) {
    setError(null);
    try {
      const { identity: updated } = await matchIdentity(identity.id, userId);
      setIdentities((list) => (onlyUnmatched && updated.userId ? list.filter((i) => i.id !== updated.id) : list.map((i) => (i.id === updated.id ? updated : i))));
      setNotice(updated.userId ? `${identity.login ?? identity.externalUserId} matched.` : `${identity.login ?? identity.externalUserId} unmatched.`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card
      title="People in connected applications"
      actions={
        <label className="flex items-center gap-2 text-[13px] text-slate-600">
          <input type="checkbox" checked={onlyUnmatched} onChange={(e) => setOnlyUnmatched(e.target.checked)} />
          Only unmatched
        </label>
      }
    >
      <p className="mb-3 text-xs text-slate-500">Match accounts to WorkAgent users so their activity is attributed to them. Bots are listed but need no match.</p>
      <ErrorAlert error={error} />
      {notice && <p role="status" className="mb-2 text-sm text-emerald-700">{notice}</p>}
      {!identities && !error && <Loading />}
      {identities?.length === 0 && <p className="text-sm text-slate-500">{onlyUnmatched ? 'Everyone is matched.' : 'No people synced yet.'}</p>}
      {identities?.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2" aria-label={i.login ?? i.externalUserId}>
              <div className="text-sm">
                <span className="font-medium text-slate-900">{i.login ?? i.externalUserId}</span>
                <span className="text-slate-500"> · {i.provider}</span>
                {i.isBot && <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">bot</span>}
                {i.matchMethod !== 'none' && <span className="ml-2 text-xs text-slate-500">matched ({i.matchMethod})</span>}
              </div>
              <select
                aria-label={`WorkAgent user for ${i.login ?? i.externalUserId}`}
                className={`${inputClass} w-56`}
                value={i.userId ?? ''}
                onChange={(e) => match(i, e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Not matched</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} ({u.email})
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
