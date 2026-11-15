import { createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node.js 22 or newer is required (running ${process.version}). Run: nvm use 22`);
  process.exit(1);
}

// Load backend/.env if present. Real environment variables always win.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

// A 32-byte key written as base64 (standard or URL-safe). Generate with: openssl rand -base64 32
const encryptionKey = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined)
  .refine((v) => !v || /^[A-Za-z0-9+/_-]+={0,2}$/.test(v), 'Must be base64 (generate with: openssl rand -base64 32)')
  .refine((v) => !v || Buffer.from(v, 'base64').length === 32, 'Must decode to exactly 32 bytes (openssl rand -base64 32)');

// Entra ids are GUIDs; not every GUID carries RFC 4122 version bits, so no strict uuid() check.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Providers WorkAPI has adapters for (services/workapi/adapters/). Add one here when adding an adapter.
export const WORKAPI_PROVIDERS = ['gemini', 'anthropic'];
// Variables from before WorkAPI. They are no longer read; startup warns when they are still set.
const LEGACY_AI_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_EFFORT', 'ANTHROPIC_MAX_OUTPUT_TOKENS', 'ANTHROPIC_TIMEOUT_MS', 'ANTHROPIC_REFUSAL_FALLBACK', 'AI_PRICE_INPUT_USD_PER_MTOK', 'AI_PRICE_OUTPUT_USD_PER_MTOK'];
// An empty value (VAR=) counts as unset.
const blank = (s) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3307),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_TEST_NAME: z.string().min(1).default('meeting_action_test'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  // Leave unset to get secure cookies only in production.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // How long an employee invitation link stays valid (default 72 h, max 30 days).
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  // WorkAPI: WorkAgent's provider-independent AI layer (services/workapi/). One provider at a time;
  // switching providers changes only these variables. Without a key the API refuses to queue
  // extractions. The key is used only in the backend and is never logged or sent to the browser.
  WORKAPI_PROVIDER: blank(z.enum(WORKAPI_PROVIDERS)).optional(),
  WORKAPI_API_KEY: blank(z.string().min(10, 'WORKAPI_API_KEY looks too short')).optional(),
  WORKAPI_MODEL: blank(z.string().min(1).max(200)).optional(),
  // Optional: a different API endpoint for the selected provider (proxy, regional or compatible gateway).
  WORKAPI_BASE_URL: blank(z.string().url()).optional(),
  // Embeddings (duplicate work detection). Optional; unset model = semantic matching off (the
  // detector then uses lexical similarity). Provider/key default to the generation ones.
  WORKAPI_EMBEDDING_PROVIDER: blank(z.enum(WORKAPI_PROVIDERS)).optional(),
  WORKAPI_EMBEDDING_API_KEY: blank(z.string().min(10, 'WORKAPI_EMBEDDING_API_KEY looks too short')).optional(),
  WORKAPI_EMBEDDING_MODEL: blank(z.string().min(1).max(200)).optional(),
  WORKAPI_EMBEDDING_DIMENSIONS: blank(z.coerce.number().int().min(64).max(4096)).optional(),
  // Per request, in milliseconds. Long meetings on slower models may need more (e.g. 300000).
  WORKAPI_TIMEOUT: z.coerce.number().int().min(1000).max(900_000).default(60_000),
  // Retries for rate limits, timeouts and provider outages inside one job attempt.
  WORKAPI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  WORKAPI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(128000).default(32000),
  // Optional provider-specific settings as JSON, validated by the selected adapter, e.g.
  // {"effort":"high"} for anthropic or {"temperature":0.2} for gemini. See docs/WORKAPI.md.
  WORKAPI_PROVIDER_OPTIONS: blank(z.string()).optional(),
  // Optional: USD per million tokens of the configured model, for cost figures. Unset = tokens
  // only (WorkAgent never guesses prices).
  WORKAPI_PRICE_INPUT_USD_PER_MTOK: blank(z.coerce.number().min(0).max(1000)).optional(),
  WORKAPI_PRICE_OUTPUT_USD_PER_MTOK: blank(z.coerce.number().min(0).max(1000)).optional(),

  // Used to resolve relative deadlines ("tomorrow", "Friday") from the meeting date.
  MEETING_TIMEZONE: z
    .string()
    .default('UTC')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Must be an IANA timezone such as "Europe/Berlin"'),
  EXTRACTION_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().positive().default(600_000),
  EXTRACTION_OUTPUT_LANGUAGE: z.string().min(2).max(40).default('English'),

  // Email notifications (Phase 5). Unset EMAIL_PROVIDER = sending disabled.
  EMAIL_PROVIDER: z.enum(['', 'smtp', 'resend']).default(''),
  EMAIL_FROM: z.string().trim().max(320).optional(),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  // Public URL of the web app, linked from emails. Omitted from emails when unset.
  APP_PUBLIC_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v), 'Must be an http(s) URL'),

  // Vexa meeting bot (Phase 7). Separate service; unset VEXA_BASE_URL/VEXA_API_KEY = disabled.
  VEXA_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'Must be an http(s) URL'),
  VEXA_API_KEY: z.string().optional(),
  VEXA_BOT_NAME: z.string().trim().min(1).max(100).default('Meeting to Action'),
  VEXA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  VEXA_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15_000),
  // Give up polling a bot after this long (default 4 h).
  VEXA_POLL_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(4 * 60 * 60 * 1000),
  // After the meeting ends, keep checking for transcript segments for this long.
  VEXA_TRANSCRIPT_WAIT_MS: z.coerce.number().int().min(0).default(5 * 60 * 1000),
  // Queue AI extraction automatically once a Vexa transcript is saved.
  VEXA_AUTO_EXTRACT: z.enum(['true', 'false']).default('true'),
  // Automatic transcription (services/vexa/autoTranscribe.js): Vexa webhooks are optional; polling
  // stays the source of truth. The secret signs Vexa's deliveries (HMAC over "<timestamp>.<body>");
  // the public URL is where Vexa can reach POST /api/v1/webhooks/vexa (e.g. https://api.example.com).
  VEXA_WEBHOOK_SECRET: blank(z.string().min(16, 'At least 16 characters')),
  VEXA_WEBHOOK_PUBLIC_URL: blank(z.string().url()),
  // How far ahead calendar meetings are considered, and how early the bot is sent (minutes).
  VEXA_AUTO_LOOKAHEAD_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  VEXA_AUTO_MAX_DISPATCH_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // Meeting transcripts from connected tools (Microsoft Teams): queue AI extraction
  // after import (never approves or emails), and only look at meetings that ended this recently.
  TRANSCRIPT_AUTO_EXTRACT: z.enum(['true', 'false']).default('true'),
  TRANSCRIPT_IMPORT_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  // Integrations (Phase 3A). Encrypts stored integration credentials (OAuth/installation tokens).
  // PREVIOUS is only needed while rotating keys (see docs/PHASE_3A_PLAN.md §6).
  CREDENTIALS_ENCRYPTION_KEY: encryptionKey,
  CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: encryptionKey,
  // Registers the built-in fake provider (no network) to try the integration UI. Ignored in production.
  INTEGRATIONS_FAKE_PROVIDER: z.enum(['true', 'false']).default('false'),
  // How often each enabled resource is re-synced (reconciliation behind webhooks).
  INTEGRATION_SYNC_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(15),
  // First sync of a resource covers this many days (plus whatever the provider says is still open).
  INTEGRATION_BACKFILL_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // One sync job runs at most this long / this many provider requests, then yields to other jobs.
  INTEGRATION_SYNC_CHUNK_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  INTEGRATION_SYNC_CHUNK_REQUESTS: z.coerce.number().int().min(1).max(1000).default(10),
  // Pause a connection when fewer provider requests than this remain in its rate-limit window.
  INTEGRATION_RATE_LIMIT_RESERVE: z.coerce.number().int().min(0).default(200),
  // Largest webhook body accepted (GitHub sends up to 25 MB; bigger changes arrive via sync).
  WEBHOOK_MAX_BYTES: z.coerce.number().int().min(1024).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
  // Webhook payloads are kept this many days (for retries and replay), then deleted.
  WEBHOOK_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  // Public base URL providers send webhooks to (shown to admins), e.g. https://workagent-dev.example.com
  PUBLIC_WEBHOOK_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(v), 'Must be an http(s) URL'),

  // GitHub App (Phase 3B). Unset GITHUB_APP_ID = GitHub integration unavailable.
  GITHUB_APP_ID: z.string().regex(/^\d+$/, 'The numeric App ID from the GitHub App settings').optional(),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/i, 'The App’s URL name (github.com/apps/<slug>)').optional(),
  // PEM text (newlines may be written as \n) or a path to the .pem file; one of the two.
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(20, 'Use a long random webhook secret (openssl rand -hex 32)').optional(),
  // Accepted as well during webhook secret rotation.
  GITHUB_WEBHOOK_SECRET_PREVIOUS: z.string().min(20).optional(),
  // Only for GitHub Enterprise Server; github.com needs no change. Must be https.
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_WEB_URL: z.string().url().default('https://github.com'),

  // Jira Cloud (OAuth 2.0 3LO app from developer.atlassian.com). Unset JIRA_CLIENT_ID = unavailable.
  JIRA_CLIENT_ID: z.string().min(10).optional(),
  JIRA_CLIENT_SECRET: z.string().min(10).optional(),
  // The one Jira site this deployment syncs, e.g. https://acme.atlassian.net
  JIRA_SITE_URL: z.string().url().optional(),
  // Secret of the webhook an admin registers in Jira (System > Webhooks); optional: without it Jira is polled only.
  JIRA_WEBHOOK_SECRET: z.string().min(20, 'Use a long random webhook secret (openssl rand -hex 32)').optional(),
  // Opt-in: request write:jira-work on Connect so admins can create issues from approved action
  // items. Add the scope to the Atlassian app first, then Connect again (runbook §11.6).
  JIRA_ISSUE_CREATION: z.enum(['true', 'false']).default('false'),
  // Microsoft Teams integration mode: real (Microsoft Graph OAuth), mock (DEVELOPMENT MOCK: a
  // clearly labelled fake connection with fictional Violin Technologies data, never in production),
  // or disabled. docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md
  TEAMS_INTEGRATION_MODE: z.enum(['real', 'mock', 'disabled']).default('real'),
  // Group invitations / conversational meetings (docs/FEATURES.md). Opt-in write and directory
  // scopes: off = the connection keeps its read-only grant and these features say why they can't run.
  // Outlook: Calendars.ReadWrite (create/cancel events, Teams meeting links).
  OUTLOOK_CALENDAR_WRITE: z.enum(['true', 'false']).default('false'),
  // Execution engine: ask Teams for ChannelMessage.Send so approved notifications can be posted to a channel.
  TEAMS_MESSAGE_SEND: z.enum(['true', 'false']).default('false'),
  // Seconds an approved plan waits before anything is written (cancel window). 0 = execute at once.
  ACTION_CANCEL_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  // Plans affecting more than this many records or people need an extra confirmation.
  ACTION_LARGE_THRESHOLD: z.coerce.number().int().min(2).max(1000).default(10),
  // Outlook: User.Read.All + GroupMember.Read.All (Entra users, departments, groups; admin consent).
  MS_DIRECTORY_SYNC: z.enum(['true', 'false']).default('false'),
  // Google: calendar.events (create/cancel events with Meet links).
  GOOGLE_CALENDAR_WRITE: z.enum(['true', 'false']).default('false'),
  // Google: Admin SDK directory read scopes (Workspace users, org units, groups; admin account).
  GOOGLE_DIRECTORY_SYNC: z.enum(['true', 'false']).default('false'),
  // A group (or the whole list) above this size needs a second confirmation before sending.
  GROUP_LARGE_THRESHOLD: z.coerce.number().int().min(2).max(10_000).default(50),
  // Organisation time zone for the weekly digest schedule and KPI periods (default MEETING_TIMEZONE).
  ORG_TIMEZONE: blank(z.string().min(1).max(64)).optional(),
  // Assistant: how long an executed command can be undone (seconds).
  ASSISTANT_UNDO_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  // Speech-to-text for voice commands: 'google' (Cloud Speech-to-Text v1, API key) or unset (the
  // browser's own speech recognition is used where available). The key never leaves the backend.
  SPEECH_PROVIDER: blank(z.enum(['google'])).optional(),
  SPEECH_API_KEY: blank(z.string().min(10)).optional(),
  SPEECH_LANGUAGE: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).default('en-US'),
  SPEECH_API_URL: z.string().url().default('https://speech.googleapis.com'),
  // Weekly digest delivery to Microsoft Teams: an incoming-webhook / Workflows URL for a channel.
  // Only team-level summaries (no individual load figures) are posted. Unset = no Teams delivery.
  DIGEST_TEAMS_WEBHOOK_URL: blank(z.string().url()).optional(),
  JIRA_AUTH_URL: z.string().url().default('https://auth.atlassian.com'),
  JIRA_API_URL: z.string().url().default('https://api.atlassian.com'),

  // Microsoft 365 (Teams and Outlook through Microsoft Graph): one single-tenant Entra app.
  MS_CLIENT_ID: z.string().regex(GUID, 'The Application (client) ID from Entra (a GUID)').optional(),
  MS_CLIENT_SECRET: z.string().min(10).optional(),
  MS_TENANT_ID: z.string().regex(GUID, 'The Directory (tenant) ID from Entra (a GUID)').optional(),
  MS_LOGIN_URL: z.string().url().default('https://login.microsoftonline.com'),
  MS_GRAPH_URL: z.string().url().default('https://graph.microsoft.com'),

  // Google Workspace Calendar (meeting discovery for Vexa, free/busy, event creation). Unset GOOGLE_CLIENT_ID = unavailable.
  // Google Meet transcripts come from the Vexa bot, not from Google.
  GOOGLE_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
  // Only accounts of this Workspace domain can connect, e.g. acme.com
  GOOGLE_WORKSPACE_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'A domain such as acme.com').optional(),
  // Without a Workspace domain: allow any Google account (personal Gmail included). Opt-in.
  GOOGLE_ALLOW_PERSONAL_ACCOUNTS: z.enum(['true', 'false']).default('false'),
  GOOGLE_AUTH_URL: z.string().url().default('https://accounts.google.com'),
  GOOGLE_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GOOGLE_CALENDAR_API_URL: z.string().url().default('https://www.googleapis.com'),

  // Figma (OAuth app from figma.com/developers). Unset FIGMA_CLIENT_ID = unavailable.
  // Empty values (FIGMA_CLIENT_ID=) count as unset, so the example file can list them blank.
  FIGMA_CLIENT_ID: blank(z.string().min(10)).optional(),
  FIGMA_CLIENT_SECRET: blank(z.string().min(10)).optional(),
  // The Figma team whose projects are synced (the number in figma.com/files/team/<id>/…).
  FIGMA_TEAM_ID: blank(z.string().regex(/^\d{1,30}$/, 'The numeric Figma team id')).optional(),
  // Passcode given when registering Figma webhooks; empty = Figma is polled only.
  FIGMA_WEBHOOK_PASSCODE: blank(z.string().min(20, 'Use a long random passcode (openssl rand -hex 32)')).optional(),
  FIGMA_AUTH_URL: z.string().url().default('https://www.figma.com'),
  FIGMA_API_URL: z.string().url().default('https://api.figma.com'),
  // Preferred names (2026-11): FIGMA_API_BASE_URL wins over FIGMA_API_URL; FIGMA_REDIRECT_URI
  // overrides the default <APP_PUBLIC_URL>/integrations/figma/setup (must match the app's
  // registered redirect URL exactly).
  FIGMA_API_BASE_URL: blank(z.string().url()).optional(),
  FIGMA_REDIRECT_URI: blank(z.string().url()).optional(),

  // Background worker / job queue
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(30_000),
  JOB_STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(300_000),
  // Optional comma list: this worker only runs these job types (e.g. a dedicated integrations
  // worker with "integration.sync,integration.webhook"). Empty = every type.
  WORKER_JOB_TYPES: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
    .refine((list) => list.every((t) => /^[a-z][a-z0-9_.]{1,63}$/.test(t)), 'Comma-separated job types, e.g. integration.sync,integration.webhook'),
});

// Cross-field rules for WorkAPI: a key needs a provider and a model; options must be a JSON object;
// prices come in pairs.
const checked = schema.superRefine((e, ctx) => {
  if (e.WORKAPI_API_KEY && !e.WORKAPI_PROVIDER) ctx.addIssue({ code: 'custom', path: ['WORKAPI_PROVIDER'], message: `Set WORKAPI_PROVIDER (${WORKAPI_PROVIDERS.join(' | ')}) for WORKAPI_API_KEY` });
  if (e.WORKAPI_API_KEY && !e.WORKAPI_MODEL) ctx.addIssue({ code: 'custom', path: ['WORKAPI_MODEL'], message: 'Set WORKAPI_MODEL to a model of the selected provider' });
  if (e.WORKAPI_PROVIDER_OPTIONS) {
    let v;
    try {
      v = JSON.parse(e.WORKAPI_PROVIDER_OPTIONS);
    } catch {
      v = null;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) ctx.addIssue({ code: 'custom', path: ['WORKAPI_PROVIDER_OPTIONS'], message: 'Must be a JSON object, e.g. {"temperature":0.2}' });
  }
  if ((e.WORKAPI_PRICE_INPUT_USD_PER_MTOK === undefined) !== (e.WORKAPI_PRICE_OUTPUT_USD_PER_MTOK === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['WORKAPI_PRICE_OUTPUT_USD_PER_MTOK'], message: 'Set both WORKAPI_PRICE_INPUT_USD_PER_MTOK and WORKAPI_PRICE_OUTPUT_USD_PER_MTOK, or neither' });
  }
});
const parsed = checked.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}\nSee backend/.env.example.`);
  process.exit(1);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

if (isProd && env.TEAMS_INTEGRATION_MODE === 'mock') {
  console.error('TEAMS_INTEGRATION_MODE=mock is a development mock and is refused in production.');
  process.exit(1);
}

if (isProd && env.JWT_SECRET.startsWith('change-me')) {
  console.error('Refusing to start in production with the example JWT_SECRET.');
  process.exit(1);
}

if (env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS && !env.CREDENTIALS_ENCRYPTION_KEY) {
  console.error('CREDENTIALS_ENCRYPTION_KEY_PREVIOUS is set without CREDENTIALS_ENCRYPTION_KEY. See backend/.env.example.');
  process.exit(1);
}

const decodeKey = (v) => (v ? Buffer.from(v, 'base64') : null);
// Tests never see the deployment's real key: each test run gets a throwaway one.
const encryptionKeys = isTest
  ? { current: randomBytes(32), previous: null }
  : { current: decodeKey(env.CREDENTIALS_ENCRYPTION_KEY), previous: decodeKey(env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) };

if (encryptionKeys.previous?.equals(encryptionKeys.current)) {
  console.error('CREDENTIALS_ENCRYPTION_KEY_PREVIOUS must differ from CREDENTIALS_ENCRYPTION_KEY.');
  process.exit(1);
}

// GitHub App private key: PEM text (\n allowed) or a file. Validated here so a bad key fails at
// startup; error messages never include the key.
function loadGithubPrivateKey() {
  if (isTest) return undefined;
  if (env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    console.error('Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH, not both.');
    process.exit(1);
  }
  let pem;
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      pem = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      console.error('GITHUB_APP_PRIVATE_KEY_PATH cannot be read.');
      process.exit(1);
    }
  } else if (env.GITHUB_APP_PRIVATE_KEY) {
    pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else {
    return undefined;
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    console.error('The GitHub App private key is not a valid RSA private key (PEM). Download a new one from the App settings.');
    process.exit(1);
  }
  return pem;
}
const githubPrivateKey = loadGithubPrivateKey();
if (!isTest && env.GITHUB_APP_ID && (!githubPrivateKey || !env.GITHUB_APP_SLUG || !env.GITHUB_WEBHOOK_SECRET)) {
  console.warn('GITHUB_APP_ID is set but GITHUB_APP_SLUG, the private key or GITHUB_WEBHOOK_SECRET is missing; GitHub stays unavailable.');
}
if (isProd && (!env.GITHUB_API_URL.startsWith('https://') || !env.GITHUB_WEB_URL.startsWith('https://'))) {
  console.error('GITHUB_API_URL and GITHUB_WEB_URL must be https in production.');
  process.exit(1);
}

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest,
  port: env.PORT,
  logLevel: isTest ? 'error' : env.LOG_LEVEL,
  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    // The test suite always runs against a separate database.
    database: isTest ? env.DB_TEST_NAME : env.DB_NAME,
  },
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },
  invitations: {
    ttlHours: env.INVITATION_TTL_HOURS,
  },
  cookie: {
    name: 'mta_session',
    secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  },
  workapi: {
    provider: env.WORKAPI_PROVIDER ?? null,
    // Never used by the test suite, which mocks WorkAPI, so tests can't make paid calls.
    apiKey: isTest ? undefined : env.WORKAPI_API_KEY,
    model: env.WORKAPI_MODEL ?? null,
    baseUrl: env.WORKAPI_BASE_URL,
    timeoutMs: env.WORKAPI_TIMEOUT,
    maxRetries: env.WORKAPI_MAX_RETRIES,
    maxOutputTokens: env.WORKAPI_MAX_OUTPUT_TOKENS,
    providerOptions: env.WORKAPI_PROVIDER_OPTIONS ? JSON.parse(env.WORKAPI_PROVIDER_OPTIONS) : {},
    prices: env.WORKAPI_PRICE_INPUT_USD_PER_MTOK !== undefined ? { input: env.WORKAPI_PRICE_INPUT_USD_PER_MTOK, output: env.WORKAPI_PRICE_OUTPUT_USD_PER_MTOK } : null,
    embedding: {
      provider: env.WORKAPI_EMBEDDING_PROVIDER ?? null,
      apiKey: isTest ? undefined : env.WORKAPI_EMBEDDING_API_KEY,
      model: env.WORKAPI_EMBEDDING_MODEL ?? null,
      dimensions: env.WORKAPI_EMBEDDING_DIMENSIONS ?? 768,
    },
    // Names only (never values) of pre-WorkAPI variables still present in the environment.
    legacyVariables: LEGACY_AI_VARIABLES.filter((k) => process.env[k] !== undefined && process.env[k] !== ''),
  },
  // Features 2-6 (docs/FEATURES.md).
  features: {
    // Tests use the real connector unless a test opts in (WORKAGENT_TEST_TEAMS_MODE), whatever .env says.
    teamsMode: isTest ? (process.env.WORKAGENT_TEST_TEAMS_MODE ?? 'real') : env.TEAMS_INTEGRATION_MODE,
    orgTimeZone: env.ORG_TIMEZONE ?? env.MEETING_TIMEZONE,
    groupLargeThreshold: env.GROUP_LARGE_THRESHOLD,
    assistantUndoSeconds: env.ASSISTANT_UNDO_SECONDS,
    outlookCalendarWrite: env.OUTLOOK_CALENDAR_WRITE === 'true',
    teamsMessageSend: env.TEAMS_MESSAGE_SEND === 'true',
    actionCancelSeconds: isTest ? 0 : env.ACTION_CANCEL_SECONDS,
    actionLargeThreshold: env.ACTION_LARGE_THRESHOLD,
    msDirectorySync: env.MS_DIRECTORY_SYNC === 'true',
    googleCalendarWrite: env.GOOGLE_CALENDAR_WRITE === 'true',
    googleDirectorySync: env.GOOGLE_DIRECTORY_SYNC === 'true',
    // Tests inject fakes; they never reach real speech or Teams endpoints.
    speech: isTest ? { provider: null, apiKey: undefined, language: env.SPEECH_LANGUAGE, apiUrl: env.SPEECH_API_URL } : { provider: env.SPEECH_PROVIDER ?? null, apiKey: env.SPEECH_API_KEY, language: env.SPEECH_LANGUAGE, apiUrl: env.SPEECH_API_URL.replace(/\/+$/, '') },
    digestTeamsWebhookUrl: isTest ? undefined : env.DIGEST_TEAMS_WEBHOOK_URL,
  },
  extraction: {
    timezone: env.MEETING_TIMEZONE,
    maxTranscriptChars: env.EXTRACTION_MAX_TRANSCRIPT_CHARS,
    outputLanguage: env.EXTRACTION_OUTPUT_LANGUAGE,
  },
  email: {
    // The test suite never uses a real provider (tests inject a fake one).
    provider: isTest ? '' : env.EMAIL_PROVIDER,
    from: env.EMAIL_FROM || undefined,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
    },
    resendApiKey: isTest ? undefined : env.RESEND_API_KEY || undefined,
    maxAttempts: env.EMAIL_MAX_ATTEMPTS,
    appPublicUrl: env.APP_PUBLIC_URL ? env.APP_PUBLIC_URL.replace(/\/+$/, '') : undefined,
  },
  vexa: {
    // Tests set their own fake endpoint and never reach a real Vexa.
    baseUrl: isTest ? undefined : env.VEXA_BASE_URL ? env.VEXA_BASE_URL.replace(/\/+$/, '') : undefined,
    apiKey: isTest ? undefined : env.VEXA_API_KEY || undefined,
    botName: env.VEXA_BOT_NAME,
    requestTimeoutMs: env.VEXA_REQUEST_TIMEOUT_MS,
    pollIntervalMs: env.VEXA_POLL_INTERVAL_MS,
    pollTimeoutMs: env.VEXA_POLL_TIMEOUT_MS,
    transcriptWaitMs: env.VEXA_TRANSCRIPT_WAIT_MS,
    autoExtract: env.VEXA_AUTO_EXTRACT === 'true',
    webhookSecret: isTest ? undefined : env.VEXA_WEBHOOK_SECRET,
    webhookPublicUrl: env.VEXA_WEBHOOK_PUBLIC_URL ? env.VEXA_WEBHOOK_PUBLIC_URL.replace(/\/+$/, '') : undefined,
    autoLookaheadHours: env.VEXA_AUTO_LOOKAHEAD_HOURS,
    autoMaxDispatchAttempts: env.VEXA_AUTO_MAX_DISPATCH_ATTEMPTS,
  },
  integrations: {
    // Buffers (or null). Only services/integrations/crypto.js reads these.
    encryptionKeys,
    // Always on in tests; never in production.
    fakeProvider: isTest || (!isProd && env.INTEGRATIONS_FAKE_PROVIDER === 'true'),
    syncIntervalMs: env.INTEGRATION_SYNC_INTERVAL_MIN * 60_000,
    backfillDays: env.INTEGRATION_BACKFILL_DAYS,
    chunkBudget: { ms: env.INTEGRATION_SYNC_CHUNK_MS, requests: env.INTEGRATION_SYNC_CHUNK_REQUESTS },
    rateLimitReserve: env.INTEGRATION_RATE_LIMIT_RESERVE,
    webhookMaxBytes: env.WEBHOOK_MAX_BYTES,
    webhookRetentionDays: env.WEBHOOK_PAYLOAD_RETENTION_DAYS,
    publicWebhookBaseUrl: env.PUBLIC_WEBHOOK_BASE_URL ? env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/+$/, '') : undefined,
    transcriptAutoExtract: env.TRANSCRIPT_AUTO_EXTRACT === 'true',
    transcriptLookbackDays: env.TRANSCRIPT_IMPORT_LOOKBACK_DAYS,
  },
  // GitHub App (Phase 3B). Tests never see real values: they configure a fake GitHub explicitly.
  github: isTest
    ? { appId: undefined, slug: undefined, privateKey: undefined, webhookSecrets: [], apiUrl: env.GITHUB_API_URL, webUrl: env.GITHUB_WEB_URL }
    : {
        appId: env.GITHUB_APP_ID,
        slug: env.GITHUB_APP_SLUG,
        privateKey: githubPrivateKey,
        webhookSecrets: [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET_PREVIOUS].filter(Boolean),
        apiUrl: env.GITHUB_API_URL.replace(/\/+$/, ''),
        webUrl: env.GITHUB_WEB_URL.replace(/\/+$/, ''),
      },
  // Jira Cloud. Tests configure a fake Jira explicitly and never see real values.
  jira: isTest
    ? { clientId: undefined, clientSecret: undefined, siteUrl: undefined, webhookSecret: undefined, issueCreation: false, authUrl: env.JIRA_AUTH_URL, apiUrl: env.JIRA_API_URL }
    : {
        clientId: env.JIRA_CLIENT_ID,
        clientSecret: env.JIRA_CLIENT_SECRET,
        siteUrl: env.JIRA_SITE_URL?.replace(/\/+$/, ''),
        webhookSecret: env.JIRA_WEBHOOK_SECRET,
        issueCreation: env.JIRA_ISSUE_CREATION === 'true',
        authUrl: env.JIRA_AUTH_URL.replace(/\/+$/, ''),
        apiUrl: env.JIRA_API_URL.replace(/\/+$/, ''),
      },
  // Microsoft Graph (Teams, Outlook). Tests configure a fake Graph explicitly.
  microsoft: isTest
    ? { clientId: undefined, clientSecret: undefined, tenantId: undefined, loginUrl: env.MS_LOGIN_URL, graphUrl: env.MS_GRAPH_URL }
    : {
        clientId: env.MS_CLIENT_ID,
        clientSecret: env.MS_CLIENT_SECRET,
        tenantId: env.MS_TENANT_ID,
        loginUrl: env.MS_LOGIN_URL.replace(/\/+$/, ''),
        graphUrl: env.MS_GRAPH_URL.replace(/\/+$/, ''),
      },
  // Google Calendar. Tests configure a fake Google explicitly.
  google: isTest
    ? { clientId: undefined, clientSecret: undefined, domain: undefined, allowPersonal: false, authUrl: env.GOOGLE_AUTH_URL, tokenUrl: env.GOOGLE_TOKEN_URL, calendarUrl: env.GOOGLE_CALENDAR_API_URL }
    : {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        domain: env.GOOGLE_WORKSPACE_DOMAIN?.toLowerCase(),
        allowPersonal: env.GOOGLE_ALLOW_PERSONAL_ACCOUNTS === 'true',
        authUrl: env.GOOGLE_AUTH_URL.replace(/\/+$/, ''),
        tokenUrl: env.GOOGLE_TOKEN_URL,
        calendarUrl: env.GOOGLE_CALENDAR_API_URL.replace(/\/+$/, ''),
      },
  // Figma. Tests configure a fake Figma explicitly.
  figma: isTest
    ? { clientId: undefined, clientSecret: undefined, teamId: undefined, webhookPasscode: undefined, redirectUri: undefined, authUrl: env.FIGMA_AUTH_URL, apiUrl: env.FIGMA_API_URL }
    : {
        clientId: env.FIGMA_CLIENT_ID,
        clientSecret: env.FIGMA_CLIENT_SECRET,
        teamId: env.FIGMA_TEAM_ID,
        webhookPasscode: env.FIGMA_WEBHOOK_PASSCODE,
        redirectUri: env.FIGMA_REDIRECT_URI,
        authUrl: env.FIGMA_AUTH_URL.replace(/\/+$/, ''),
        apiUrl: (env.FIGMA_API_BASE_URL ?? env.FIGMA_API_URL).replace(/\/+$/, ''),
      },
  jobs: {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    backoffBaseMs: env.JOB_BACKOFF_BASE_MS,
    staleAfterMs: env.JOB_STALE_AFTER_MS,
    workerTypes: env.WORKER_JOB_TYPES,
  },
};
