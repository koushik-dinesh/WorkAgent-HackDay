// Clears every organisational and transactional row of the LOCAL DEVELOPMENT database
// (docs/SEED_DATA_ARCHITECTURE.md §4). Schema, migrations, app settings and real provider
// connections (with their encrypted credentials, resources and cursors) are kept.
//
//   npm run db:backup:dev
//   npm run db:reset:dev -- --confirm meeting_action --backup ../backups/<file>.sql
//
// Refuses unless: NODE_ENV is not production, DB_HOST is local, --confirm repeats DB_NAME, the
// name does not look like production, and --backup names a complete dump of this database that
// contains every current table. Runs in one transaction with foreign-key checks on.
import { readFileSync, statSync } from 'node:fs';
import { config } from '../../config/index.js';
import { pool } from '../pool.js';
import { withTransaction } from '../transaction.js';

const MOCK_SOURCES = ['microsoft.mock-violin-technologies'];
const SEED_PREFIX = 'seed.';

// Child-to-parent order. Every table of the schema is either here or in KEPT (checked below).
const CLEARED = [
  'email_message_items', 'email_attempts', 'email_messages',
  'action_executions', 'action_plans',
  'assistant_messages', 'command_invocations', 'assistant_conversations',
  'action_item_exports', 'action_item_evidence', 'duplicate_candidates', 'work_item_embeddings', 'record_links', 'action_source_scans',
  'activities', 'action_items',
  'meeting_decisions', 'extraction_runs', 'meeting_transcript_imports', 'meeting_bot_sessions', 'meeting_invitees', 'meeting_invite_groups',
  'meeting_schedules', 'meeting_participants', 'transcript_segments', 'transcripts', 'meetings',
  'external_records', 'external_identities', 'webhook_deliveries', 'integration_auth_states',
  'user_group_nesting', 'user_group_members', 'user_groups',
  'project_members', 'team_members', 'teams', 'projects',
  'kpi_access_log', 'kpi_corrections', 'kpi_employee_notices', 'employee_metrics', 'employee_profiles',
  'weekly_digest_recipients', 'weekly_digests', 'digest_subscriptions',
  'notifications', 'user_preferences', 'user_sessions', 'user_invitations', 'user_aliases',
  'mock_records', 'audit_logs', 'jobs', 'vexa_webhook_events',
  'users', 'departments',
];
// Kept tables (integration tables keep only real connections; see clearConnections).
const KEPT = ['schema_migrations', 'app_settings', 'integration_connections', 'integration_credentials', 'integration_resources', 'integration_sync_cursors'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

function fail(message) {
  console.error(`Refusing to reset: ${message}`);
  process.exit(1);
}

async function checkTarget() {
  const db = config.db.database;
  if (config.isProd || process.env.NODE_ENV === 'production') fail('NODE_ENV is production');
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(config.db.host))) fail(`DB_HOST ${config.db.host} is not local`);
  if (/prod|live|client|customer/i.test(db)) fail(`database name ${db} looks like a production database`);
  if (arg('confirm') !== db) fail(`pass --confirm ${db} to confirm the database name`);

  const file = arg('backup');
  if (!file) fail('pass --backup <file> (create one with npm run db:backup:dev)');
  let text;
  try {
    if (statSync(file).size < 1000) fail(`backup ${file} is too small`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    fail(`backup ${file} is not readable (${err.message})`);
  }
  if (!text.trimEnd().split('\n').pop().startsWith('-- Dump completed')) fail(`backup ${file} is incomplete (no "-- Dump completed")`);
  if (!new RegExp(`Database: ${db}\\b`).test(text.slice(0, 2000))) fail(`backup ${file} is not a dump of ${db}`);

  const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  const names = tables.map((r) => r.t);
  const missing = names.filter((t) => !text.includes(`CREATE TABLE \`${t}\``));
  if (missing.length) fail(`backup ${file} lacks tables: ${missing.join(', ')}`);
  const unknown = names.filter((t) => !CLEARED.includes(t) && !KEPT.includes(t));
  if (unknown.length) fail(`tables not covered by the reset (update resetDev.js first): ${unknown.join(', ')}`);
  return { db, file, tables: names };
}

const isReal = (c) => {
  const s = typeof c.settings === 'string' ? JSON.parse(c.settings) : c.settings ?? {};
  return !MOCK_SOURCES.includes(c.source_instance) && !c.source_instance.startsWith(SEED_PREFIX) && !['mock', 'seed'].includes(s?.mode);
};

async function reset() {
  const target = await checkTarget();
  const before = {};
  for (const t of target.tables) before[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);

  const result = await withTransaction(async (conn) => {
    const deleted = {};
    const [conns] = await conn.query('SELECT id, provider, source_instance, display_name, settings FROM integration_connections FOR UPDATE');
    const real = conns.filter(isReal);
    const other = conns.filter((c) => !isReal(c)).map((c) => c.id);

    for (const t of CLEARED) {
      if (t === 'external_records') await conn.query('UPDATE external_records SET parent_record_id = NULL WHERE parent_record_id IS NOT NULL');
      if (t === 'webhook_deliveries') {
        // Mock/seed connections go before people and projects; real ones only lose their project mapping.
        if (other.length) {
          await conn.query('DELETE FROM integration_resources WHERE connection_id IN (?)', [other]);
          deleted.integration_connections = (await conn.query('DELETE FROM integration_connections WHERE id IN (?)', [other]))[0].affectedRows;
        }
        await conn.query('UPDATE integration_resources SET project_id = NULL WHERE project_id IS NOT NULL');
      }
      deleted[t] = (await conn.query(`DELETE FROM \`${t}\``))[0].affectedRows;
    }
    return { deleted, keptConnections: real.map((c) => ({ id: c.id, provider: c.provider, displayName: c.display_name })), removedConnections: other };
  });

  // Fresh ids for cleared tables (table option only; InnoDB uses max(id)+1, i.e. 1 when empty).
  for (const t of CLEARED) {
    const [[col]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND extra LIKE '%auto_increment%'", [t]);
    if (Number(col.n)) await pool.query(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1`);
  }

  const after = {};
  for (const t of target.tables) after[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  const leftovers = CLEARED.filter((t) => after[t] > 0);
  console.log(JSON.stringify({ database: target.db, backup: target.file, keptConnections: result.keptConnections, removedConnections: result.removedConnections, before, after, leftovers }, null, 2));
  if (leftovers.length) {
    console.error(`Rows were written during the reset (a running worker?): ${leftovers.join(', ')}`);
    process.exitCode = 2;
  }
}

reset()
  .catch((err) => {
    console.error(`reset failed (nothing was changed if this happened inside the transaction): ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
