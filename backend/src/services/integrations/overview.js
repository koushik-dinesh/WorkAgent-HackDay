// Integrations dashboard summary: one card per provider with an honest state —
//   not_configured  the server lacks configuration (the card says exactly what is missing)
//   disconnected    configured, no active connection
//   syncing         a sync job of the connection is queued or running
//   error           the connection needs a reconnect or its syncs are failing
//   connected       active and healthy (or not synced yet)
// plus provider details (Figma: account, team, projects, files; Teams: mock mode and counts).
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import * as connectionsRepo from '../../repositories/integrationConnectionsRepository.js';
import { mockSummary } from './mock/teamsMock.js';
import { MOCK_SOURCE } from './providers/microsoft/teamsMock.js';
import { registry as defaultRegistry } from './registry.js';

const SETUP_DOCS = { figma: 'docs/integrations/FIGMA_SETUP.md', microsoft_teams: 'docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md' };
const count = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);

async function currentConnection(provider) {
  const [[row]] = await pool.query(
    "SELECT id FROM integration_connections WHERE provider = ? ORDER BY status = 'disconnected', COALESCE(connected_at, created_at) DESC, id DESC LIMIT 1",
    [provider],
  );
  return row ? connectionsRepo.findById(row.id) : null;
}

async function isSyncing(connectionId) {
  return (
    (await count(
      `SELECT COUNT(*) AS n FROM jobs j JOIN integration_resources r ON r.id = JSON_EXTRACT(j.payload, '$.resourceId')
       WHERE j.type = 'integration.sync' AND j.status IN ('pending','running') AND r.connection_id = ?`,
      [connectionId],
    )) > 0
  );
}

function stateOf(problem, c, syncing) {
  if (problem && !(c && c.status !== 'disconnected')) return 'not_configured';
  if (!c || c.status === 'disconnected') return 'disconnected';
  if (syncing) return 'syncing';
  if (['error', 'suspended'].includes(c.status) || c.health === 'failing') return 'error';
  return 'connected';
}

async function figmaDetails(c) {
  if (!c) return {};
  const s = c.settings ?? {};
  return {
    account: s.me?.email ?? s.connectedAs ?? c.accountLogin,
    accountHandle: s.connectedAs ?? null,
    teams: s.teamId ? [{ id: s.teamId, name: s.teamName ?? `Team ${s.teamId}` }] : [],
    projects: await count("SELECT COUNT(*) AS n FROM integration_resources WHERE connection_id = ? AND resource_type = 'project' AND access_status = 'accessible'", [c.id]),
    projectsEnabled: await count("SELECT COUNT(*) AS n FROM integration_resources WHERE connection_id = ? AND resource_type = 'project' AND access_status = 'accessible' AND is_enabled = TRUE", [c.id]),
    files: await count("SELECT COUNT(*) AS n FROM external_records WHERE connection_id = ? AND record_type = 'design_file' AND source_deleted_at IS NULL", [c.id]),
    comments: await count("SELECT COUNT(*) AS n FROM external_records WHERE connection_id = ? AND record_type = 'comment' AND source_deleted_at IS NULL", [c.id]),
    versions: await count("SELECT COUNT(*) AS n FROM external_records WHERE connection_id = ? AND record_type = 'version' AND source_deleted_at IS NULL", [c.id]),
  };
}

export async function overview({ registry = defaultRegistry } = {}) {
  const cards = [];
  for (const p of registry.list()) {
    const c = await currentConnection(p.id);
    const syncing = c && c.status !== 'disconnected' ? await isSyncing(c.id) : false;
    const card = {
      provider: p.id,
      displayName: p.id === 'microsoft_teams' ? 'Microsoft Teams' : p.displayName,
      available: p.available,
      problem: p.problem,
      state: stateOf(p.problem, c, syncing),
      setupDoc: SETUP_DOCS[p.id] ?? null,
      connection: c ? { id: c.id, status: c.status, displayName: c.displayName, accountLogin: c.accountLogin, health: c.health, lastSyncSucceededAt: c.lastSyncSucceededAt, lastSyncStartedAt: c.lastSyncStartedAt, lastErrorMessage: c.lastErrorMessage } : null,
      mode: 'real',
    };
    if (p.id === 'figma') Object.assign(card, { figma: await figmaDetails(c && c.status !== 'disconnected' ? c : null) });
    if (p.id === 'microsoft_teams') {
      card.mode = config.features.teamsMode;
      const isMockConnection = c?.sourceInstance === MOCK_SOURCE;
      card.mock = isMockConnection || card.mode === 'mock';
      if (card.mock) {
        const s = await mockSummary();
        Object.assign(card, { teams: { account: s.connection?.account ?? null, organisation: s.connection?.organisation ?? null, verified: false, counts: s.counts } });
      }
    }
    cards.push(card);
  }
  return { cards };
}
