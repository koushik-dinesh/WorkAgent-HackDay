# WorkAgent — Current Status Report (technical handover)

**Audit date:** 2026-11-14 · **Commit audited:** `6f7c2d8` on `main` (= `origin/main`, `github.com/koushik-dinesh/WorkAgent-GDG`) plus 4 uncommitted files (Google personal-account option, see §16).
**Method:** source read of `backend/src` and `frontend/src`; read-only SQL against the local dev DB (`meeting_action`) and test DB; full backend and frontend test runs; production build; `npm audit`/`npm outdated`; one free Anthropic Models API call to check the configured key. No application code was changed. No paid AI calls were made. Docker Desktop and the project's MySQL/Mailpit containers were started for the checks (they were stopped).

**Evidence labels used throughout**

| Label | Meaning |
|---|---|
| **VERIFIED-LIVE** | Rows in the dev DB prove it ran against the real external service, or it was exercised live today |
| **VERIFIED-TEST** | Exercised by the automated suite (against local fakes/mocks, never the real provider) |
| **CODE-ONLY** | Code read; nothing exercised it |
| **ASSUMPTION** | Inference, stated as such |

---

## 1. Executive Summary

> **Update 2026-11-15 (later) — WorkAPI: provider-independent AI.** All AI now goes through `backend/src/services/workapi/` with Gemini (`@google/genai` 2.32.0) and Anthropic adapters; the provider is chosen by `WORKAPI_PROVIDER`/`WORKAPI_API_KEY`/`WORKAPI_MODEL`. `ANTHROPIC_*`/`AI_PRICE_*` are no longer read; `backend/.env` was migrated after a backup. Backend 657/657, frontend 133/133 with mocked provider transports; **live Gemini smoke test passed on `gemini-3.5-flash`** (see §23.3); Claude not tested live. Details: §23 and `docs/WORKAPI.md`.

> **Update 2026-11-15 — Teams meetings, unified transcript import and Jira issue creation (built and tested against fakes; NOT live-verified).** Details: §22. In short: the Teams connector now discovers Teams meetings and downloads their transcripts; Teams and Google Meet transcripts flow into the same extraction → validation → review pipeline as uploads and Vexa; admins can create an approved action item as a Jira issue (opt-in, `JIRA_ISSUE_CREATION`). Backend 634/634, frontend 133/133. Production activation needs a Microsoft 365 tenant with admin consent, a valid Anthropic key, and `write:jira-work` on the Atlassian app. Migration `011` was applied to the dev database on 2026-11-15 after a verified backup and rehearsal (`docs/runbooks/database-migrations.md`).

WorkAgent (still named "AI Meeting to Action" in code, cookies, DB and package names) is a **single-company, self-hosted web app**: React SPA → Express 5 API → MySQL 8.4, with a separate MySQL-backed job worker. It turns meeting transcripts into reviewed action items with Claude, emails assignees, gives employees a task portal, and ingests work data (read-only) from external tools into a unified feed with correlation suggestions, insights and notifications.

**Honest state in one paragraph:** the codebase is large (≈26.5k lines, ~110 endpoints, 33 tables, 10 migrations), clean, consistently layered and well tested against fakes (backend 618/618, frontend 128/128, build OK). Two connectors — **Jira Cloud and GitHub — have really connected and synced live** (small test data, last successful sync 2026-11-04). But: **(1) the Anthropic API key currently configured is rejected by the API, so AI extraction does not work today**; (2) real Claude extraction has only ever run 5 times, on transcripts of at most ~1,200 characters — never on a realistic meeting; (3) **no integration writes anything back** — approved action items are never created as Jira issues or GitHub issues, so the "AI → approval → create tasks in external tools" loop does not exist; (4) Teams, Outlook, Google Meet (connector) and Figma are code + fake-tested only (no credentials); (5) there is **no deployment path at all** (no Dockerfile for API/worker/SPA, no CI, no HTTPS, no backup automation, no password reset).

| Headline metric | Value |
|---|---|
| Overall completion (weighted, §20) | **≈ 55 %** of the intended production product |
| Current stage | **Late prototype / internal-demo stage** (feature-rich, not deployable) |
| Features (44 tracked, §4) | 24 complete · 4 partial · 2 needs testing · 12 not started · 2 blocked |
| Integrations (11, §5) | 3 working live (GitHub, Jira, SMTP via Mailpit) · 1 broken now (Claude) · 1 environment-dependent (Vexa) · 4 code-only · 2 unconfigured |
| AI maturity | **Level 2 of 5** — well-engineered single-shot extraction + deterministic validation; not working today (key); never tested on real-length meetings |
| Production readiness | **3.9 / 10** |

---

## 2. Current Application Status

| Area | Status | Evidence |
|---|---|---|
| Repository | `main` == `origin/main` (`6f7c2d8 "project ceompleted"`, 2026-10-31). 4 modified, uncommitted files. No other branches remain (docs still refer to `phase-2-work-management` — stale). | `git branch -a`, `git status` |
| Dev database | All 10 migrations applied (latest `010_notifications.sql`, 2026-10-31). Contents: 19 users (4 admin, 3 manager, 12 employee), 24 meetings (8 with a completed Vexa bot, 2 failed), 15 action items (12 approved), 5 transcripts, 2 sent emails, 2 live integration connections, 15 synced external records, 27 notifications, 123 jobs. | read-only SQL |
| Test database | All 10 migrations applied (docs claim it stayed at 009 — stale). | `meeting_action_test.schema_migrations` |
| Running services | Nothing was running at audit start (Docker daemon down). `~/vexa` (external Vexa checkout) exists but was not started. | `docker ps`, `lsof` |
| Last real usage | Last meeting row 2026-11-05; last session 2026-10-31; last integration sync 2026-11-04 03:28. One `vexa.poll` job has been `pending` since 2026-11-05 (no worker running). | `jobs`, `meetings` |
| AI provider | **Configured key rejected: HTTP 401 from the real Anthropic API** (re-checked with any inherited `ANTHROPIC_BASE_URL` removed; see §20.3). Configured model `claude-haiku-5-5`, effort `medium`. *2026-11-15: replaced by WorkAPI (§23); `WORKAPI_PROVIDER=gemini` with no key yet.* | live Models API call, `backend/.env` keys (values not read into report) |

---

## 3. Architecture Overview

### 3.1 Stack (verified from `package.json`, lockfiles and code)

| Layer | Technology |
|---|---|
| Frontend | React 19.3, react-router 8.5 (`createBrowserRouter`), Vite 8.3, Tailwind 4.3, Vitest 5 + Testing Library + jsdom. No state library; per-page fetch via `frontend/src/api/*.js` → `client.js`. |
| Backend | Node ≥22 (ESM), Express 5.3, `mysql2` (raw parameterised SQL, no ORM), zod 4 (env + request validation), bcrypt 6, jsonwebtoken 9, cookie-parser, nodemailer 10.0.16, `@anthropic-ai/sdk` 1.1.0 |
| Database | MySQL 8.4 in Docker (`docker-compose.yml`, host port 3307), utf8mb4. Plain-SQL migrations with checksum enforcement (`backend/src/db/migrate.js`). |
| Queue / workers | MySQL `jobs` table, `FOR UPDATE SKIP LOCKED`, leases + heartbeats, exponential backoff, dedupe keys, `dead` state (`backend/src/jobs/queue.js`, `runner.js`, `worker.js`). No Redis. |
| Mail (dev) | Mailpit container (SMTP :1025, UI :8025). Resend supported via `fetch` (not configured). |
| Meeting capture | Vexa (separate open-source stack at `~/vexa`, gateway :18056, faster-whisper :8083) — Google Meet only. |
| AI | Anthropic Messages API, streaming, structured output (`output_config.format` JSON schema), effort, refusal-fallback beta. |

### 3.2 Process and data flow

```
Browser (React SPA :5173) ──/api proxy (Vite dev only)──▶ Express API :4000 ──▶ MySQL :3307
                                                            │  enqueue rows in `jobs`        ▲
Provider webhooks ─▶ POST /api/v1/webhooks/:provider ───────┤                                │
                                                            ▼                                │
                                     Worker (src/worker.js) — claims jobs ───────────────────┘
                                       ai.extract            → Anthropic (claudeClient.js)
                                       email.send            → SMTP / Resend
                                       vexa.poll             → Vexa REST → transcript import → ai.extract
                                       integration.sync      → GitHub/Jira/Graph/Google/Figma (read-only)
                                       integration.webhook   → ingest signed deliveries
                                       integration.maintenance, correlation.evaluate, notifications.scan
```

Backend layering is strict: `routes/` (zod + auth guards) → `controllers/` → `services/` → `repositories/` (SQL). Only `services/ai/claudeClient.js`, `services/vexa/client.js`, `services/email/*Provider.js` and `services/integrations/providers/**` talk to the outside world.

### 3.3 Auth and authorization

- Login → bcrypt (12 rounds, timing-equalised) → HS256 JWT containing a random `sid`, in httpOnly `SameSite=Lax` cookie (`Secure` in production). Every request re-checks a live `user_sessions` row and an active user (`middleware/auth.js`, `services/authService.js`). Logout, deactivation and password change revoke sessions server-side.
- Roles: `admin`, `manager`, `employee`. Admin-only routers: `/users`, `/meetings`, `/action-items`, `/emails`, `/ops`, `/integrations`. Per-resource checks for projects/teams/records in `services/permissions.js` and `services/records/access.js`.
- Onboarding is invitation-only (emailed token, single use, expiry). **No self-service password reset.**
- In-memory fixed-window rate limits on login, invitations, extraction, email send, bot, password (`middleware/rateLimit.js`) — lost on restart, per-process only.

### 3.4 Configuration

All env validated by zod in `backend/src/config/index.js` (412 lines). Root `.env` = docker-compose only; `backend/.env` = app. External credentials are forced off when `NODE_ENV=test`, so tests can never hit real providers. Secrets are git-ignored (`.gitignore` covers `.env`, `backups/`); verified that no `.env`, `.pem` or backup is tracked.

### 3.5 Deployment architecture

**None exists.** Startup is `start.sh` (macOS/Linux dev: starts Vexa compose stacks from `~/vexa`, app compose, `npm run dev`, worker, Vite dev server, logs/PIDs in `.run/`) and `end.sh`. No Dockerfile for API/worker/SPA, no reverse proxy/HTTPS config, no static serving of the built SPA (the API serves only `/api/v1`; same-origin is achieved only by the Vite dev proxy), no CI (`.github/` absent), no IaC.

---

## 4. Complete Feature Inventory

Status key: **COMPLETE** · **PARTIAL** · **NOT STARTED** · **BLOCKED** · **NEEDS TESTING**.

### 4.1 Core platform

| # | Feature | Status | Implementation (backend / frontend / DB) | Working | Incomplete / next |
|---|---|---|---|---|---|
| 1 | Login, sessions, logout | COMPLETE | `routes/auth.js`, `services/authService.js`, `middleware/auth.js` / `pages/LoginPage.jsx`, `auth/*` / `users`, `user_sessions` | VERIFIED-TEST + dev DB has 35 sessions | Rate limiter in-memory; no MFA/SSO |
| 2 | Invitations & account activation | COMPLETE | `services/invitations.js`, `routes/users.js` `/:id/invitations` / `pages/AcceptInvitation.jsx` / `user_invitations` | VERIFIED-TEST; 2 invitations in dev DB | Needs real outbound email for non-dev use |
| 3 | Password reset (forgot password) | NOT STARTED | — | — | Invitation refuses users who already have a password; admins cannot reset either |
| 4 | Password change, profile, preferences | COMPLETE | `routes/me.js` / `pages/Profile.jsx` / `user_preferences` | VERIFIED-TEST | — |
| 5 | User management & name aliases | COMPLETE | `controllers/usersController.js` / `pages/admin/Users.jsx` / `users`, `user_aliases` | VERIFIED-TEST (0 aliases in dev DB) | — |
| 6 | Roles & permissions | PARTIAL | `services/permissions.js`, `requireRole` | VERIFIED-TEST | **Managers cannot see or create meetings** (whole `/meetings` router is admin-only) — the meeting workflow is admin-only |
| 7 | Projects (CRUD, owner, members, archive) | COMPLETE | `controllers/projectsController.js` / `pages/projects/*` / `projects`, `project_members` | VERIFIED-TEST; 5 projects in dev | — |
| 8 | Teams | COMPLETE | `controllers/teamsController.js` / `pages/teams/Teams.jsx` / `teams`, `team_members` | VERIFIED-TEST (0 teams in dev DB — never used for real) | — |
| 9 | Audit log | COMPLETE | `services/audit.js` / Ops → Audit / `audit_logs` (216 rows) | VERIFIED-TEST | No retention policy |

### 4.2 Meeting → action pipeline

| # | Feature | Status | Implementation | Working | Incomplete / next |
|---|---|---|---|---|---|
| 10 | Meetings CRUD, participants | COMPLETE | `routes/meetings.js` / `pages/admin/Meetings*.jsx` / `meetings`, `meeting_participants` | VERIFIED-TEST | Admin-only (see #6) |
| 11 | Transcript upload & parsing (plain/VTT/SRT/Vexa JSON) | COMPLETE | `services/transcripts/parser.js`, `controllers/transcriptsController.js` / `TranscriptUpload.jsx`, `TranscriptViewer.jsx` / `transcripts`, `transcript_segments` | VERIFIED-TEST (incl. multilingual fixture) | — |
| 12 | Vexa meeting bot (join Google Meet, transcribe, import) | NEEDS TESTING | `services/meetingBot.js`, `services/vexa/*`, `jobs/handlers/vexaPoll.js` / `MeetingBotPanel.jsx` | VERIFIED-LIVE historically: 8 meetings `bot_status=completed`, transcripts with `en`/`hi`; VERIFIED-TEST with fake Vexa | Depends on a local Vexa install outside this repo; **Google Meet links only** (`parseGoogleMeetUrl`); 1 dead poll ("Vexa returned a different meeting on this link"), 1 poll stuck pending; not running now |
| 13 | AI action-item extraction | **BLOCKED** | `services/extraction.js`, `jobs/handlers/aiExtract.js`, `services/ai/*` / `review/ExtractionPanel.jsx` / `extraction_runs` | Code complete; VERIFIED-TEST with mocked `claude.extract`; VERIFIED-LIVE only 5 runs (2026-10-22→24, ≤812 input tokens) | **Configured API key rejected today.** Never run on a realistic transcript (largest stored transcript is 1,169 chars). See §6 |
| 14 | Deterministic validation (evidence, assignee, deadline, dedupe) | COMPLETE | `services/ai/validator.js` (314 lines), `matching/assigneeMatcher.js`, `utils/dates.js` | VERIFIED-TEST (unit + pipeline) | Quality on real model output unmeasured |
| 15 | Human review & approval | COMPLETE | `services/review.js`, `controllers/actionItemsController.js`, `/meetings/:id/approve` / `pages/admin/ReviewActionItems.jsx`, `review/*` / `action_items`, `action_item_evidence` | VERIFIED-TEST; 12 approved items in dev | — |
| 16 | Manual action items | COMPLETE | `POST /meetings/:id/action-items` / `ActionItemForm.jsx` | VERIFIED-TEST | — |
| 17 | Email of approved items to assignees | NEEDS TESTING | `services/notifications.js`, `services/email/*`, `jobs/handlers/emailSend.js` / `MeetingEmails.jsx` / `email_messages`, `email_attempts`, `email_message_items` | VERIFIED-LIVE to Mailpit only (2 sent); VERIFIED-TEST (fake provider) | Never delivered to a real inbox; Resend not configured; nodemailer has a moderate advisory (§11) |
| 18 | Employee task portal (My Tasks, status changes) | COMPLETE | `routes/tasks.js`, `services/tasks.js` / `pages/employee/*`, `components/tasks/TaskStatus.jsx` | VERIFIED-TEST | Tasks exist only inside WorkAgent |
| 19 | Create approved tasks in Jira (GitHub: not started) | **NEEDS TESTING** (since 2026-11-15) | `services/externalTasks.js`, `providers/jira` `createIssue`, job `action_item.export`, `POST /action-items/:id/exports` / `components/review/JiraExport.jsx` / `action_item_exports` (migration 011) | VERIFIED-TEST against fake Jira + browser check against fake Jira | Live Jira write not run; opt-in `JIRA_ISSUE_CREATION`; no status write-back from WorkAgent to Jira; GitHub issues not built (§22) |

### 4.3 Integrations & unified data

| # | Feature | Status | Implementation | Working | Incomplete / next |
|---|---|---|---|---|---|
| 20 | Integration framework (registry, contract, vault, OAuth state, HTTP client, sync engine, scheduler, webhooks, replay, retention) | COMPLETE | `services/integrations/*` (14 files) / `pages/admin/Integrations*.jsx`, `IntegrationSetup.jsx` / `integration_*`, `webhook_deliveries` | VERIFIED-LIVE via GitHub + Jira; VERIFIED-TEST (contract suite, leak test) | — |
| 21 | Credential encryption (AES-256-GCM, rotation) | COMPLETE | `integrations/crypto.js`, `vault.js`, `scripts/rotateCredentials.js` | VERIFIED-TEST; key set in dev | Key stored in `.env` (no KMS) |
| 22 | Identity mapping (external people → users) | PARTIAL | `externalIdentitiesRepository.js`, `/integrations/identities` | 2 identities in dev | Only provider-verified email matches automatically; rest manual |
| 23 | Unified records, activity feed | COMPLETE | `services/records/*`, `services/activities/*`, `routes/workRecords.js` / `ActivityFeed.jsx`, `RecordDetail.jsx`, `RelatedRecords.jsx` / `external_records`, `activities`, `record_links` | VERIFIED-LIVE (66 activities) + TEST | — |
| 24 | Search | COMPLETE | `services/search.js` (MySQL FULLTEXT + LIKE) / `SearchPage.jsx` | VERIFIED-TEST | No stemming/typo tolerance |
| 25 | Correlation suggestions | COMPLETE | `services/correlation/*`, job `correlation.evaluate` / `Suggestions.jsx` | VERIFIED-LIVE (8 suggested links, 0 confirmed) + TEST | Deterministic rules only (keys, word overlap, time window); no embeddings/LLM |
| 26 | Insights / dashboard | COMPLETE | `services/insights.js` (430 lines), `GET /insights` / `Insights.jsx`, `admin/Dashboard.jsx` | VERIFIED-TEST | Rule thresholds hard-coded; computed per request; **no AI-generated insight** |
| 27 | Project "Development" card (issues/PRs) | COMPLETE | `components/DevelopmentCard.jsx` | VERIFIED-TEST | — |

### 4.4 Operations & notifications

| # | Feature | Status | Implementation | Working | Incomplete / next |
|---|---|---|---|---|---|
| 28 | Job queue & worker | COMPLETE | `jobs/*`, `worker.js`, `WORKER_JOB_TYPES` | VERIFIED-LIVE (123 jobs) + TEST | No process supervisor; worker must be started by hand |
| 29 | Operations center (jobs retry/cancel, audit, email, AI runs) | COMPLETE | `services/ops.js`, `routes/ops.js` / `admin/Operations.jsx` | VERIFIED-TEST | — |
| 30 | AI token/cost tracking | PARTIAL | `extraction_runs.input/output_tokens`, `AI_PRICE_*` env | Tokens recorded | Prices unset → no cost shown; no budget/limit enforcement |
| 31 | In-app notifications (assignment, overdue, blocked, digest, suggestions, failures) | COMPLETE | `services/notifications/*`, job `notifications.scan` / `Notifications.jsx` / `notifications` | VERIFIED-LIVE (27 rows) + TEST | — |
| 32 | Email channel for notifications | NOT STARTED | — | — | Deferred in `PHASE_10_NOTIFICATIONS.md` |
| 33 | Automation policies / approval queue for external writes | NOT STARTED | — | — | Depends on #19 |
| 34 | Data retention (notifications, audit, sessions) | PARTIAL | Webhook payload retention + expired session cleanup exist | — | No retention for audit/notifications/transcripts |
| 35 | Health endpoint | COMPLETE | `GET /api/v1/health` (DB ping) | — | No worker heartbeat/liveness |

### 4.5 Planned but absent

| # | Feature | Status | Notes |
|---|---|---|---|
| 36 | Extraction from other sources (email, chat, Jira/GitHub comments) | NOT STARTED | Extraction input is meeting transcripts only |
| 37 | Transcripts from Teams / Google Meet (connectors) | **NEEDS TESTING** (since 2026-11-15) | Teams: meeting discovery + Graph transcript download; Google Meet: transcript entries via Meet API; shared importer `services/transcripts/importer.js`, job `meeting.transcript_import`; table `meeting_transcript_imports`. Verified only against fakes (§22) |
| 38 | Report generation / export (PDF/CSV/email digests of insights) | NOT STARTED | Insights are on-screen only |
| 39 | Commitments / decisions / blockers as first-class records | NOT STARTED | Roadmap Phase 4 remainder |
| 40 | Deployment packaging (Docker images, proxy, HTTPS) | NOT STARTED | §12 |
| 41 | CI pipeline | NOT STARTED | No `.github/` |
| 42 | Browser E2E tests | NOT STARTED | Only manual browser checks recorded in docs |
| 43 | Product rename (Meeting to Action → WorkAgent) | NOT STARTED | `mta_session` cookie, `meeting_action` DB, package names |
| 44 | Meeting capture device | BLOCKED | Separate hardware workstream; nothing in repo |

**Counts (44 features, as of 2026-11-15):** COMPLETE **24** (1,2,4,5,7,8,9,10,11,14,15,16,18,20,21,23,24,25,26,27,28,29,31,35) · PARTIAL **4** (6,22,30,34) · NEEDS TESTING **4** (12,17,19,37) · NOT STARTED **10** (3,32,33,36,38,39,40,41,42,43) · BLOCKED **2** (13,44). (Audit of 2026-11-14: NEEDS TESTING 2, NOT STARTED 12.)

> The four connectors that exist only in code (Teams, Outlook, Google Meet, Figma) are tracked in §5 rather than as separate features here; counted as features they would be 4 more PARTIAL.

---

## 5. Integration Status

| Integration | Implementation | Authentication | API connection | Data sync | Tested | Remaining work |
|---|---|---|---|---|---|---|
| **Jira Cloud** | Complete for read; issue creation implemented (opt-in, fake-tested, §22) — `providers/jira/` | OAuth 2.0 3LO, rotating refresh tokens in vault | **VERIFIED-LIVE**: connection #1 `workagent.atlassian.net`, active/healthy | **VERIFIED-LIVE**: 4 issues + 1 comment; 1 signed webhook processed; last sync 2026-11-04 | 22 tests vs fake Atlassian + live dev site; issue creation: pipeline tests vs fake only | Live issue creation untested (needs `write:jira-work` on the app + reconnect); only one site per deployment; tested on tiny data only |
| **GitHub (App)** | Complete (read-only) — `providers/github/` | App JWT + installation tokens | **VERIFIED-LIVE**: connection #2, installed on a *personal user account* | **VERIFIED-LIVE**: repo, 2 issues, 1 PR, 3 commits, review, comments; 10 webhook deliveries processed (issues, push, PR, review…) | 46 tests vs fake GitHub + live | No write-back; never tested on an organisation install or volume; **1 dead `integration.sync` job** (`GET /repos/koushik-dinesh/workagent-integration-test failed` — repo likely renamed/removed; not cleaned up) |
| **Microsoft Teams** | Code complete: channel messages, **meeting discovery, transcript download** (since 2026-11-15) | Delegated OAuth (Entra), meeting scopes optional | Not configured (`MS_CLIENT_ID` unset); **no tenant/admin access** | CODE-ONLY / fake | 25 (+meeting tests in `meetingPipeline.test.js`) vs fake Graph; browser check vs fake | M365 work tenant + Entra app + admin consent (§22.3); transcription policy; change notifications not implemented |
| **Outlook** | Code complete (mail/calendar delta) | Same Entra app | Not configured | CODE-ONLY / fake | (shared with Teams) | Same as Teams |
| **Google Meet connector** | Code complete (Calendar events with Meet, conference records) | Workspace OAuth (+ uncommitted personal-account option) | Not configured | CODE-ONLY / fake | 14 (+1 uncommitted) tests vs fake Google | Credentials; push (Pub/Sub) not implemented; transcript import added 2026-11-15 (fake-tested only) |
| **Figma** | Code complete (files, comments, versions, passcode webhooks) | OAuth | Not configured | CODE-ONLY / fake | 15 tests vs fake Figma | Credentials and live verification |
| **Vexa (meeting bot)** | Complete for Google Meet | `X-API-Key` | VERIFIED-LIVE historically (8 completed bots) | Transcript import → auto extraction | Fake Vexa tests | External, unpackaged dependency (`~/vexa`); Google Meet only; poller edge cases seen live (dead job, stuck pending job) |
| **Anthropic Claude** | Complete | API key | **FAILING TODAY — key rejected** | n/a | Mocked only in suite; 5 small live runs in Oct | Valid key; real-length evaluation (§6) |
| **SMTP (Mailpit)** | Complete | none in dev | VERIFIED-LIVE (2 messages sent) | n/a | Fake provider tests | Real SMTP relay/domain (SPF/DKIM) |
| **Resend** | Code complete (`fetch`) | API key | Not configured | — | Fake tests | Key + verified domain |
| **Cloudflare tunnel / webhook gateway** | Dev helper `scripts/webhookGateway.js` | — | `PUBLIC_WEBHOOK_BASE_URL` set; GitHub/Jira webhooks did arrive → VERIFIED-LIVE in dev | — | none | Production ingress design; the doc it references (`docs/PROVIDER_SETUP_GUIDE.md`) **does not exist** |
| Slack, Zoom, Linear, Confluence, Notion | Not started | — | — | — | — | Not in any plan file in the repo |

**Summary:** fully working live: **2 external connectors** (Jira, GitHub, both read-only) + SMTP-to-Mailpit. Implemented but not functional end-to-end: Claude (key), Teams, Outlook, Google Meet connector, Figma. Configuration pending/credentials required: Teams, Outlook, Google, Figma, Resend, valid Anthropic key. Environment-dependent: Vexa. **No integration writes data back to its provider.**

---

## 6. AI Capabilities Status

| Capability | Status | Detail (file) |
|---|---|---|
| LLM provider integration | Real SDK code, **currently non-functional** | `services/ai/claudeClient.js`: official `@anthropic-ai/sdk`, `messages.stream().finalMessage()`, `output_config: { effort, format: json_schema }`, refusal-fallback beta (`server-side-fallback-2026-07-01`, `fallbacks: 'default'`), typed error classification (retryable vs permanent). These parameters match current API docs. Worker start-up calls `models.retrieve` to verify the model. **Today that call fails: API key rejected.** |
| Model choice | Configured `claude-haiku-5-5`, effort `medium` (`.env.example` default is `claude-opus-5-5`/`high`) | ASSUMPTION/risk: `ANTHROPIC_REFUSAL_FALLBACK=true` sends the server-side fallback beta; current docs state Haiku 5.5 refusals have no server-side fallback — this combination is unverified and may be rejected. Test before relying on it. |
| Prompt engineering | Real, versioned (`PROMPT_VERSION = 'v1'`) | `services/ai/extractionPrompt.js`: fixed system prompt (precision over recall, injection warnings, owner/deadline/evidence rules), transcript in delimited `<transcript>` with `[S#]` line refs, tag neutralisation. No prompt registry/A-B; one prompt. |
| Prompt caching | Present but likely ineffective | `cache_control` on a ~700-token system prompt — below typical minimum cacheable prefix, so probably never cached (ASSUMPTION; `cache_read_input_tokens` is not recorded). |
| Transcript processing | Real | Parser (4 formats), segment refs, 600k-char cap (`EXTRACTION_MAX_TRANSCRIPT_CHARS`), no chunking — over-cap transcripts are refused (422), not split. |
| Vexa integration | Real (Google Meet only) | `meetingBot.js` → `vexaPoll` → transcript import → auto `ai.extract` (`VEXA_AUTO_EXTRACT`). Never auto-approves or emails. |
| Action-item extraction | Real code; output validated | Structured JSON schema; per-item zod validation. |
| Assignee matching | Real, deterministic | `matching/assigneeMatcher.js`: exact/alias → high, unique first name → medium + flag, ambiguous/unknown/inactive → unassigned + flag. Name must appear in transcript. Never infers emails. |
| Deadline extraction | Real, deterministic cross-check | `utils/dates.js` resolver vs model's `due_date_resolved`; conflicting/ambiguous/past → null + flag; meeting date (not processing date) is the reference; timezone from `MEETING_TIMEZONE` (one global zone). |
| Validation | Strong | `validator.js`: verbatim-quote evidence check against stored segments, items without verified evidence rejected, dedupe vs prior reviewed items, truncation flags. |
| AI-generated task creation | Internal only | Items saved as `pending` `action_items`; become tasks only after approval. Nothing created externally. |
| Human approval | Real, enforced | Approval blocked until an active assignee is set and blocking flags resolved (`services/review.js`). Emails only on explicit admin action. |
| Background processing | Real | `ai.extract` job, idempotent (re-run replaces pending AI items), supersession checks, no DB lock during the API call. |
| Errors & retries | Real | SDK `maxRetries: 2` + queue retries (`JOB_MAX_ATTEMPTS=3`, backoff); permanent errors (auth, 400, refusal, `max_tokens`) fail fast with a public message. |
| Token usage & cost | Partial | Tokens stored per run and shown in Ops → AI usage; cost only if `AI_PRICE_*` set (unset); no per-period budget or alert. |
| Response quality & reliability | **Unmeasured** | No eval set, no golden transcripts, no precision/recall metrics. Live evidence: 5 runs on tiny inputs (output 10–2,723 tokens). |
| Other AI features | None | Correlation, insights, summaries and notifications are **rule-based, no LLM**. |

**What is real vs mocked:**
- Real code paths: everything in the table above.
- Mocked in tests: every backend test replaces `claude.extract` (`backend/test/extraction.test.js` lines 14–120) or relies on `config.ai.apiKey` being forced `undefined` in test mode. **No test calls Claude.**
- Hardcoded/placeholder responses in production code: **none found** (grep for TODO/FIXME/placeholder/mock in `src/` found none relevant).
- Tested with a real LLM: only the 5 historical runs; **not re-verifiable today** because the key is rejected.

**AI maturity: Level 2 / 5** — (1) prototype call → **(2) production-shaped single task with validation and human review** → (3) evaluated & monitored → (4) multi-source/agentic → (5) autonomous with policy controls.

---

## 7. End-to-End Workflow Status

### W1 — Meeting (Google Meet via Vexa) → reviewed tasks → email
| Step | Implementation | Status |
|---|---|---|
| Admin logs in | `/auth/login` | ✅ |
| Create meeting with Meet link | `POST /meetings` | ✅ (admin only) |
| Send bot | `POST /meetings/:id/bot` → Vexa | ⚠️ needs local Vexa running; Google Meet only |
| Poll, import transcript | `vexa.poll` | ⚠️ worked historically; edge cases seen |
| AI extraction | `ai.extract` | ❌ **fails today (API key)** |
| Validate, flag | `validator.js` | ✅ |
| Human review/approve | Review UI | ✅ |
| Email assignees | `email.send` | ✅ to Mailpit only |
| Employee works task | My Tasks | ✅ |
| Insights/notifications | `/insights`, `notifications.scan` | ✅ |
**Can it execute end-to-end today? No** — blocked at extraction. With a valid key and Vexa started: yes, in a dev environment.

### W2 — Uploaded transcript → tasks
Same as W1 without Vexa. **Blocked only by the API key.** Manual action items (no AI) work fully today.

### W3 — Connect Jira/GitHub → sync → unified feed → correlation → insights
Login → Admin → Integrations → Connect (OAuth / App install) → map project/repo to project → sync/webhooks → `external_records`/`activities` → correlation suggestions → insights. **Executes today (VERIFIED-LIVE for Jira and GitHub, dev, tiny data)**, requires worker running and, for webhooks, a public tunnel.

### W4 — The intended "agent" loop
`Login → Connect services → Gather data → AI analysis → Extract → Validate → Human approval → Create/Update tasks in external tools → Sync → Track execution → Reports`

| Step | Status |
|---|---|
| Gather data from Jira/GitHub | ✅ (read-only) |
| Gather data from Teams/Outlook/Meet/Figma | ⚠️ code only, no credentials |
| AI analysis of synced data | ❌ not implemented — AI only reads meeting transcripts |
| Extract / validate / approve | ✅ for transcripts only (AI currently blocked) |
| **Create/update tasks in Jira/GitHub** | ❌ **not implemented** (no write scopes, no write code, no approval queue) |
| Track execution | ⚠️ internal task status + synced external status, but approved items are not linked to external issues unless a human confirms a correlation suggestion |
| Generate reports | ⚠️ on-screen insights only; no export/scheduled report |
**Can it execute? No.** Missing links: AI over non-meeting sources, external write-back, approval queue for external writes, reporting.

### W5 — Employee onboarding
Admin invites → email → accept → login → My Tasks. **Works in dev (Mailpit)**; no password recovery afterwards.

---

## 8. Database and Backend Status

**Migrations** (`backend/src/db/migrations/`): `001_init` (users, meetings, transcripts, action items, jobs, audit), `002_extraction_pipeline`, `003_vexa_bot`, `004_work_management` (sessions, invitations, projects, teams), `005_integrations`, `006_work_records`, `007_sync_cursor_completion`, `008_unified_feed_search` (FULLTEXT), `009_operations_center` (indexes), `010_notifications`. Checksums enforced; dev and test DBs both at 010 with identical checksums. Rollback scripts exist for 005–006, 008, 009, 010 (`docs/runbooks/`), **none for 001–004, 007**. Migrations are forward-only SQL run by `npm run migrate`; there is no down-migration tool.

**Tables (33):** `users, user_aliases, user_sessions, user_invitations, user_preferences, projects, project_members, teams, team_members, meetings, meeting_participants, transcripts, transcript_segments, extraction_runs, action_items, action_item_evidence, email_messages, email_message_items, email_attempts, jobs, audit_logs, notifications, integration_connections, integration_credentials, integration_resources, integration_sync_cursors, integration_auth_states, webhook_deliveries, external_records, external_identities, activities, record_links, schema_migrations`.

**API:** ~110 endpoints under `/api/v1` (`auth`, `users`, `meetings`, `action-items`, `emails`, `ops`, `integrations`, `webhooks`, `external-records`, `activities`, `record-links`, `search`, `insights`, `me`, `me/tasks`, `projects`, `teams`, `directory`, `health`). Full route list derivable from `backend/src/routes/*.js`; README's API table covers only the pre-integration subset.

**Backend quality:** consistent layering, zod on every input, parameterised SQL everywhere, transactions with row locks where state changes, idempotent jobs, structured JSON logging with key-based redaction (`utils/logger.js`). Single-tenant by design (no tenant columns).

**Backend issues found:** in-memory rate limiting; no `trust proxy` (client IP wrong behind a proxy → rate limit by proxy IP); no security headers beyond 4 basic ones (no CSP/HSTS); worker has no heartbeat table; `projectOfFile` cache in Figma is process-local; single global `MEETING_TIMEZONE`.

---

## 9. Frontend Status

- 15 pages + ~15 components; routes in `frontend/src/router.jsx` with role guards (`ProtectedRoute`): admin (`/admin`, meetings, users, integrations, operations), employee/manager (`/my/tasks`), all roles (projects, teams, activity, records, search, insights, notifications, profile), admin/manager (`/suggestions`).
- UI exists for every backend feature listed as COMPLETE; nothing found that is UI-only without backend.
- Tests: **128/128 pass, 15 files** (component/page tests with mocked API modules — none hit the backend).
- Build: OK; **single JS bundle 514 kB (146 kB gzip) exceeds Vite's 500 kB warning** — no code splitting.
- Gaps: no password-reset screen; managers have no meetings UI; no i18n; no error-reporting (Sentry etc.); production serving of `dist/` undefined (dev relies on Vite proxy for same-origin cookies).
- Browser verification history exists only in docs (manual); not reproducible automatically.

---

## 10. Testing and Quality Status

| Check | Result (2026-11-14) |
|---|---|
| Backend `npm test` (node:test, real MySQL test DB) | **618 passed / 618**, 160 suites, 0 failed/skipped, 105.8 s (618 = 617 committed + 1 uncommitted Google test) |
| Frontend `vitest run` | **128 passed / 128, 15 files**, 6.5 s |
| Frontend production build | OK (warning: 514 kB chunk) |
| `npm audit` backend | **1 moderate**: nodemailer 10.0.16 address-parser advisories (recipient injection via crafted display names); fix: 10.5.0 (non-major) |
| `npm audit` frontend | 0 vulnerabilities |
| `npm outdated` | Minor updates only (`@anthropic-ai/sdk` 1.1.0→1.8.0, vite, vitest, react-router patch, etc.) |
| Live Anthropic key check | **Failed — key rejected** |

**Mocked vs real:**
- All backend tests run against a real MySQL test database (real SQL, transactions, locking) — genuinely integration-level for the DB.
- **Every external service is faked:** Claude (method replacement), Vexa (fake fetch), email (fake provider), GitHub/Jira/Graph/Google/Figma (local fake HTTP servers in `backend/test/integrations/fake*.js`, run through the shared contract suite `contract.js`).
- **No test exercises a real external integration.** Live evidence comes only from the dev DB (§5).
- No browser E2E tests (Playwright/Cypress absent). No load tests. No CI to run any of it automatically. No coverage reporting configured.

**Error handling / logging:** central `errorHandler` with `AppError` codes and public messages; job failures recorded with `last_error`; JSON-lines logs to stdout with secret redaction (a dedicated leak-regression test exists: `integrationsLeak.test.js`). No log shipping, no request IDs/correlation IDs.

---

## 11. Security Assessment

**Strengths (verified in code):** bcrypt-12 with timing equalisation; server-side revocable sessions; httpOnly/SameSite cookies; role + per-resource authorization on the server; zod validation on all routes; parameterised SQL; AES-256-GCM credential vault with rotation; signed webhooks (HMAC for GitHub/Jira, constant-time passcode for Figma) with dedupe and size limit; OAuth single-use hashed state; SSRF limited to configured provider origins; prompt-injection precautions; secrets git-ignored; log redaction + leak test.

**Weaknesses / risks:**
1. **No HTTPS/deployment config**; `Secure` cookie only when `NODE_ENV=production`.
2. No CSRF token — relies on `SameSite=Lax` + JSON content type (acceptable for same-origin SPA, but brittle if CORS or form posts are ever added).
3. No CSP/HSTS headers; no `helmet`.
4. In-memory rate limits (reset on restart, not shared); no account lockout.
5. No password reset (operational risk: admins re-create accounts) and no MFA/SSO.
6. nodemailer moderate advisory (recipient parsing).
7. Encryption key and all secrets in a plain `.env` on disk; no secret manager.
8. Real credentials (Anthropic, Vexa, Jira, GitHub App key path, encryption key, webhook secrets) live in `backend/.env` on a developer laptop; `backups/` contains full SQL dumps and `backend.env.bak-20261031` (git-ignored, but unencrypted on disk).
9. Uploaded transcripts and AI raw responses are stored indefinitely (no retention) — privacy exposure for recorded meetings.
10. No dependency scanning or SAST in CI (no CI).

Security score: **5/10** (good application-level design, nothing at the infrastructure level).

---

## 12. Production Readiness Assessment

### 12.1 Category ratings

| Category | Score | Justification |
|---|---|---|
| Security | 5 | Strong app-level controls (§11); no HTTPS, headers, secret management, MFA, reset |
| Scalability | 4 | MySQL queue with SKIP LOCKED scales to several workers; but in-memory rate limits and caches, insights computed per request, single-company design, no load testing |
| Reliability | 6 | Idempotent jobs, leases, retries, dead-letter, stale-safe ingest; but no supervisor, no worker heartbeat, stuck/dead jobs found in dev not auto-resolved |
| Monitoring | 2 | Ops center + `/health` only; no metrics, alerting, uptime checks, error tracking |
| Logging | 5 | Structured, redacted JSON logs; no shipping, retention or request correlation |
| Backup & recovery | 2 | Manual `mysqldump` files in `backups/`; no schedule, offsite copy or tested restore runbook; rollback scripts for some migrations only |
| Deployment | 1 | No container images, proxy, HTTPS, CI/CD or environment separation; dev scripts only |
| Configuration management | 6 | zod-validated env with clear `.env.example`; no secret manager, no per-environment profiles |
| Integration stability | 4 | 2 connectors proven live on tiny data; 4 unproven; Vexa external and fragile; Claude currently failing |
| Error recovery | 6 | Retry/cancel from UI for safe job types; domain-specific retries; no automated recovery for poller edge cases |
| **Average** | **3.9 / 10** | |

### 12.2 Suitability by stage

| Stage | Verdict | Blockers |
|---|---|---|
| Local development | **Yes** | Start Docker; fix Anthropic key; Vexa optional |
| Internal demonstration | **Yes, after fixing the key** | Valid Anthropic key; rehearse on a realistic transcript; start worker and (optionally) Vexa; seed demo data |
| Client demonstration | **Conditional** | Above + test extraction on 30–60 min real meetings; demo Jira/GitHub on a cleaner org/project; avoid claiming Teams/Outlook/Figma/Meet connectors work; explain that tasks are not pushed to Jira |
| Pilot deployment | **No** | Deployment packaging + HTTPS, password reset, real email provider, backups, monitoring, nodemailer upgrade, manager meeting access, data retention policy, AI eval |
| Production | **No** | All pilot blockers + CI, E2E tests, external write-back with approval queue (if part of the promise), secret management, alerting, load test, security review |

---

## 13. Completed Work

Phases 1, 2/2.5 (work management), 3A (integration framework), 3B (GitHub), 4 (unified records/feed/search), 5 (correlation), 7 (insights), 8 (operations center), 10 (in-app notifications only). The original meeting-to-action prototype (transcripts, Claude extraction pipeline, validation, review, email, employee portal, Vexa). Jira and GitHub connected live in dev. All of it is committed and pushed to `origin/main`.

## 14. Partially Completed Work

- AI extraction (code done; blocked by key; unevaluated on real meetings).
- Vexa bot (works for Google Meet in a local Vexa stack; external dependency; edge-case jobs left dead/pending).
- Email (Mailpit only; no real provider verified).
- Teams, Outlook, Google Meet connector, Figma (code + fakes; no credentials; no push notifications for Graph/Google).
- Identity mapping (manual beyond verified emails).
- Permissions (managers excluded from meetings).
- AI cost tracking (no prices, no budgets).
- Data retention (webhook payloads only).
- Phase 6 generalized AI engine (meetings only), Phase 9 sync hardening, Phase 10 automation, Phase 11 production readiness.

## 15. Pending Work

External write-back (Jira/GitHub issue creation from approved items) and its approval queue; AI over non-meeting sources; native Teams/Meet transcripts; reports/export; password reset; deployment packaging; CI; E2E tests; backups/monitoring; email notification channel; commitments/decisions/blockers model; product rename; meeting device.

## 16. Known Bugs and Technical Debt

| # | Item | Evidence |
|---|---|---|
| 1 | **Anthropic API key rejected** — extraction unusable | Live Models API check |
| 2 | Possible incompatibility: `claude-haiku-5-5` + `ANTHROPIC_REFUSAL_FALLBACK=true` (server-side fallback not available for Haiku 5.5 per current docs) | `backend/.env`, `claudeClient.js` — unverified |
| 3 | Dead `integration.sync` job for a GitHub repo that no longer resolves | `jobs` |
| 4 | Dead `vexa.poll` job ("different meeting on this link") and one `vexa.poll` pending since 2026-11-05 | `jobs` |
| 5 | Failed `email.send` job referencing message id 2147483000 (test artefact in dev DB) | `jobs` |
| 6 | 4 uncommitted files (Google personal-account support + test) | `git status` |
| 7 | Last commit message "project ceompleted" — misleading (project is not complete) and typo | `git log` |
| 8 | Single 514 kB frontend bundle | build output |
| 9 | nodemailer 10.0.16 advisory | `npm audit` |
| 10 | In-memory rate limiting / Figma cache — break with >1 API process | `middleware/rateLimit.js`, `figma/index.js` |
| 11 | Product name mismatch (code "Meeting to Action", product "WorkAgent") | package names, cookie `mta_session`, DB `meeting_action` |
| 12 | Insights thresholds hard-coded (`RULES` in `services/insights.js`) | code |
| 13 | Prompt cache likely never hit (system prompt below minimum cacheable size); cache-read tokens not recorded | `claudeClient.js` |
| 14 | No chunking for long transcripts (>600k chars rejected) | `extraction.js` |
| 15 | Global `MEETING_TIMEZONE` for deadline resolution (not per meeting/user) | `config`, `aiExtract.js` |
| 16 | Verification leftovers in dev DB (`verify-*@workagent.test` users, "Verification Project 2.5") | `WORKAGENT_CURRENT_STATE.md` |
| 17 | The SDK honours an inherited `ANTHROPIC_BASE_URL` environment variable; the app neither sets nor guards it, so a stray value in the host environment silently redirects all AI calls (and the API key) to another endpoint | Observed during this audit (§R0 log) |

**Documentation discrepancies (docs vs reality):**
- `docs/PROJECT_STATUS.md`, `WORKAGENT_CURRENT_STATE.md`, `WORKAGENT_MASTER_ROADMAP.md`: "GitHub/Jira **none live-verified**" → dev DB shows both connected live with real webhooks (2026-10-31).
- `PROJECT_STATUS.md`: "branch `phase-2-work-management` exists only on this machine; never pushed" → branch no longer exists; everything is on `main`, which is pushed.
- `PROJECT_STATUS.md`: "test database is at 009" → it is at 010.
- `scripts/webhookGateway.js` references `docs/PROVIDER_SETUP_GUIDE.md` → file does not exist.
- `README.md` describes only the v1 meeting-to-action prototype (no integrations, insights, ops, notifications) and its API table is incomplete.
- Roadmap Phase 9 row says "Sync cursors, webhook ingestion, token refresh" remaining → these were implemented in 3A/3B.
- Roadmap Phase 11 lists "secret encryption" remaining → credential vault encryption exists.

## 17. External Dependencies and Blockers

| Dependency | Needed for | Owner action |
|---|---|---|
| Valid Anthropic API key (and model decision) | All AI | Generate/replace key in Console; set model/effort |
| Vexa stack (self-hosted, `~/vexa`) or a hosted alternative | Bot capture | Decide to keep/package Vexa or replace |
| Microsoft Entra app (tenant admin consent) | Teams, Outlook | Create app per runbook §12 |
| Google Workspace OAuth client (+ Pub/Sub for push) | Google Meet connector | Runbook §13 |
| Figma OAuth app + team id | Figma | Runbook §14 |
| Jira write scopes / GitHub App write permissions | External task creation | Product decision + app reconfiguration |
| Production email (SMTP relay or Resend + verified domain) | Invitations, task emails | Domain/DNS |
| Hosting target, domain, TLS | Pilot | Infra decision |
| Customer data-retention / recording-consent policy | Pilot with real meetings | Legal/product |

## 18. Remaining Development Phases

| Phase | Goal | Est. (1 dev + AI assist; estimate) |
|---|---|---|
| **R0 — Stabilise & re-verify** | Fix key, clean dead jobs, commit pending work, refresh docs, realistic AI smoke tests | 2–4 days |
| **R1 — AI quality** | Eval set (10–20 real transcripts), metrics, model/effort choice, cost tracking, long-transcript handling | 1–2 weeks |
| **R2 — External write-back** | Approved item → Jira issue / GitHub issue with approval queue, link back, status sync | 2–3 weeks |
| **R3 — Connector completion** | Live-verify Teams/Outlook/Meet/Figma or cut scope; native meeting transcripts | 2–4 weeks (credential-dependent) |
| **R4 — Production readiness** | Docker images, proxy/HTTPS, CI, E2E, backups, monitoring/alerting, password reset, retention, security review | 3–4 weeks |
| **R5 — Pilot** | Deploy for one customer, operate, fix | 2–4 weeks |
| R6 (optional) | AI over other sources, reports/export, automation policies, rename, device | open-ended |

**Remaining major phases to production: 5 (R0–R4), plus a pilot (R5).** Realistic calendar: **~10–16 weeks** for one developer.

## 19. Prioritized Roadmap

### P0 — Critical blockers

| Item | Dependencies | Acceptance criteria |
|---|---|---|
| P0-1 Restore AI: valid key, confirm model/effort/fallback combination | Anthropic account | Worker logs "claude model verified"; one extraction succeeds end to end; `extraction_runs` row with tokens |
| P0-2 Realistic AI smoke test | P0-1 | ≥5 real meetings of 20–60 min (incl. multilingual) extracted; reviewer records precision/recall per meeting; results written to docs |
| P0-3 Repo hygiene | — | Uncommitted Google change committed or dropped; dead/pending jobs resolved; docs corrected per §16 |
| P0-4 Deployment baseline | Hosting decision | Dockerfiles for API, worker, SPA (static); reverse proxy with HTTPS; `trust proxy`; one-command deploy documented and executed on a staging host |
| P0-5 Password reset | Email provider | Activated user can reset via emailed single-use token; sessions revoked; tests |
| P0-6 Backups & restore | P0-4 | Scheduled encrypted dumps offsite; restore rehearsed and timed; runbook |

### P1 — Essential functionality

| Item | Dependencies | Acceptance criteria |
|---|---|---|
| P1-1 Approved item → Jira issue (with approval queue) | Jira write scope | Admin approves → preview → create issue; issue key stored and linked (`record_links`); status flows back via sync; audited; idempotent |
| P1-2 Same for GitHub issues | GitHub App `issues:write` | As P1-1 |
| P1-3 Production email | Domain | Invitation and task email delivered to external inboxes; SPF/DKIM pass; nodemailer ≥10.5 |
| P1-4 Manager access to meetings in their projects | — | Managers create/review meetings for projects they manage; tests for scoping |
| P1-5 CI | — | Backend + frontend tests, build and `npm audit` on every push |
| P1-6 Monitoring & alerting | P0-4 | Uptime check, error tracking, alert on dead jobs / failing connection / worker down |
| P1-7 AI eval harness | P0-2 | Versioned golden set; script reports precision/recall/assignee/deadline accuracy per prompt/model |

### P2 — Important improvements

| Item | Dependencies | Acceptance criteria |
|---|---|---|
| P2-1 Live-verify Teams/Outlook | Entra app | Connect, sync, deletions observed live; runbook confirmed |
| P2-2 Live-verify Google Meet & Figma (or remove from UI) | OAuth clients | Same |
| P2-3 Native meeting transcripts (Teams/Meet) into extraction | P2-1/2 | A Teams or Meet transcript is imported without Vexa |
| P2-4 Browser E2E suite | P1-5 | Playwright covers login, meeting→review→email, integrations connect (fake), employee flow |
| P2-5 Data retention & privacy | Policy | Configurable retention for transcripts, raw AI output, audit, notifications |
| P2-6 Persistent rate limiting, security headers, CSP/HSTS | — | Limits survive restart and multiple instances; headers verified |
| P2-7 Frontend code splitting | — | No chunk >500 kB |
| P2-8 Configurable insight thresholds | — | Admin-editable rules |

### P3 — Optional enhancements

AI over Jira/GitHub/email/chat content; LLM-assisted correlation; generated reports/exports and scheduled digests by email; commitments/decisions/blockers records; automation policies; product rename; MFA/SSO; Slack/Zoom connectors; meeting device.

---

## 20. Final Assessment

### 20.1 Overall completion: ≈ 55 %

Weighted by what a production WorkAgent must deliver (weights are a judgement; scores are from this audit):

| Area | Weight | Done | Contribution |
|---|---|---|---|
| Core work management (auth, users, projects, teams, tasks) | 15 % | 90 % (no reset, manager meetings) | 13.5 |
| Meeting → action pipeline (capture, AI, validation, review, email) | 20 % | 75 % (code complete; AI blocked & unevaluated; email dev-only) | 15.0 |
| Read integrations & unified data | 15 % | 65 % (framework + 2 live of 6) | 9.8 |
| External write-back & automation | 15 % | 0 % | 0.0 |
| Intelligence (correlation, insights) | 10 % | 70 % (deterministic only) | 7.0 |
| Operations & notifications | 5 % | 85 % | 4.3 |
| Production readiness (deploy, CI, security, backups, monitoring) | 20 % | 15 % | 3.0 |
| **Total** | 100 % | | **≈ 52.6 → reported as ~55 %** (±5 %) |

Feature-count view (44 tracked): 24 complete = 55 % — consistent with the weighted figure.

### 20.2 Final deliverable summary

| # | Item | Answer |
|---|---|---|
| 1 | Overall completion | **~55 %** (weighted; §20.1) |
| 2 | Development stage | **Late prototype / internal-demo ready (once the AI key is fixed); not pilot-ready** |
| 3 | Feature counts (44) | **24 complete · 4 partial · 2 needs testing · 12 not started · 2 blocked** |
| 4 | Integrations | **3 working live** (Jira, GitHub, SMTP/Mailpit) **vs 8 pending/not functional** (Claude-broken, Vexa-env, Teams, Outlook, Google Meet, Figma, Resend, prod ingress); **0 with write-back** |
| 5 | AI maturity | **Level 2/5** — sound single-task design with deterministic validation and human approval; currently non-functional (key); never evaluated on real-length meetings |
| 6 | Production readiness | **3.9 / 10** |
| 7 | Top 10 next actions | 1) Replace the Anthropic key and verify model/fallback config · 2) Run extraction on 5+ real 20–60 min meetings and record accuracy · 3) Commit/clean pending changes, dead jobs and stale docs · 4) Dockerise API/worker/SPA behind HTTPS on a staging host · 5) Password reset · 6) Production email + nodemailer upgrade · 7) Automated, offsite, restore-tested backups · 8) CI with tests/build/audit · 9) Approved item → Jira issue with approval queue and link-back · 10) Monitoring/alerting for worker, dead jobs and connections |
| 8 | Remaining phases | **5 major phases (R0–R4) + pilot (R5)**, ≈ 10–16 weeks for one developer |

### 20.3 R0 progress log (2026-11-14)

| R0 item | Result |
|---|---|
| Diagnose Anthropic key | First check went through an `ANTHROPIC_BASE_URL` inherited from the audit tool's shell. Re-run against the real API with that variable unset: **HTTP 401 — the key is invalid or revoked.** Format is fine (106 chars, `sk-ant-` prefix, no quotes/whitespace). **Owner action: create a new key in the Anthropic Console and put it in `backend/.env`.** |
| Dead / stuck jobs | No database changes made. #147 (`vexa.poll`, meeting 24 "Call With Anjana", pending) will complete once the worker and Vexa run — start them only after the key is replaced, or auto-extraction will fail the meeting. #27 (Vexa returned a different meeting; meeting 14 failed), #113 (sync of a GitHub resource that no longer exists) and #48 (test artefact, nonexistent email message) are terminal history; left in place. Meeting 14 can be recovered from its page with a manual transcript upload. |
| Uncommitted Google change | Reviewed; fixed a message that read "Only accounts of undefined can be connected" when personal accounts are allowed. `googleMeet.test.js` 15/15. Not committed yet. |
| Stale docs | `PROJECT_STATUS.md` rewritten; correction banners on `WORKAGENT_CURRENT_STATE.md`, `WORKAGENT_MASTER_ROADMAP.md`, `README.md`; `scripts/webhookGateway.js` now points to `docs/runbooks/integrations.md §3` instead of a missing file. |
| Realistic AI smoke test | **Blocked** on a valid key. When unblocked: run 5+ real 20–60 min transcripts (incl. one multilingual), record precision/recall, assignee and deadline accuracy per meeting, and confirm `claude-haiku-5-5` + `ANTHROPIC_REFUSAL_FALLBACK=true` is accepted (otherwise set it to `false` for Haiku or use `claude-opus-5-5`). |

**Bottom line for the next developer:** the foundation is genuinely good — well layered, secure by design at the application level, idempotent, heavily tested against fakes, and two real connectors have worked. Do not mistake that for "complete": the AI path is broken right now and unproven at real scale, nothing is pushed back into Jira/GitHub, four of six connectors have never touched a real provider, and there is no way to deploy it. Start with R0 (days), then decide whether the product promise for the first customer includes external write-back (R2) before investing in more connectors.

---

## 22. Microsoft Teams, unified transcripts and Jira issue creation (2026-11-15)

Context: no Microsoft 365 tenant with admin rights is available (the free E5 developer sandbox requires Visual Studio / partner eligibility; the Business Basic trial in India requires GSTIN verification). Everything below was built and tested **against local fakes only**. Nothing here was run against Microsoft, Google, Atlassian or Anthropic.

### 22.1 What was built

| Piece | Files | Behaviour |
|---|---|---|
| Teams meeting discovery | `providers/microsoft/teams.js` (`meetingEnvelopes`, `syncMeetings`), `graph.js` (`hasScopes`, optional scopes) | Optional meeting scopes; "Teams meetings" resource; `GET /me/calendarView/delta` (backfill window → +14 days, window renewed); only Teams online meetings become `teams_meeting` records (start/end, organizer, attendee e-mails, join link); deletions as tombstones |
| Teams transcript retrieval | `teams.js` `fetchTranscript` | `GET /me/onlineMeetings?$filter=JoinWebUrl eq '…'` → `/transcripts` → newest `/content?$format=text/vtt`; *ready / not_ready / none*; 403 → *failed* with an admin-consent hint |
| Google Meet transcript retrieval | `providers/google/meet.js` `fetchTranscript` | Meet REST `transcripts` → `entries` (paged) + participant names; existing `meetings.space.readonly` scope |
| Unified transcript processing | `services/transcripts/importer.js`, `repositories/transcriptImportsRepository.js`, job `meeting.transcript_import`, worker every 5 min | Same parser as uploads; creates/finds a WorkAgent meeting (platform = provider), participants by e-mail, project from the resource, *same_as* link, never overwrites; waits up to 24 h for a transcript; then `queueAutoExtraction` — **the same function Vexa now uses** (`services/extraction.js`) |
| AI extraction, assignee + deadline matching, human approval | unchanged (`aiExtract`, `validator.js`, `assigneeMatcher.js`, `review.js`) | Imported transcripts go through the existing pipeline; review/approval stays manual |
| Jira task creation | `providers/jira/index.js` `createIssue`, `services/externalTasks.js`, job `action_item.export`, `routes/actionItems.js` (`GET /action-items/export-targets`, `GET /action-items/exports?meetingId=`, `POST /action-items/:id/exports`), `components/review/JiraExport.jsx` | Only for **approved** items and only on an admin's explicit click; issue type Task; summary/description/due date/labels; assignee from the people mapping (falls back to unassigned); idempotent by label `workagent-item-<id>`; created issue ingested and linked (*tracks*); failures shown with retry; audited. **Opt-in:** `JIRA_ISSUE_CREATION=true` + `write:jira-work` on the Atlassian app + reconnect — off by default so the live read-only Jira connection is unaffected |
| UI | `pages/admin/MeetingDetail.jsx`, `pages/admin/ReviewActionItems.jsx`, `components/review/ActionItemCard.jsx` | Imported meetings show "Transcript imported from Microsoft Teams/Google Meet" and no bot panel; approved items show the Jira control and the created key |
| Schema | `011_meeting_imports_and_exports.sql` (+ `docs/runbooks/rollback-011.sql`) | Additive: `meeting_transcript_imports`, `action_item_exports`. Applied to the test DB and, on 2026-11-15, to the dev DB (backup `backups/meeting_action-pre-011-20261115-063243.sql`) |
| Config | `TRANSCRIPT_AUTO_EXTRACT` (true), `TRANSCRIPT_IMPORT_LOOKBACK_DAYS` (7), `JIRA_ISSUE_CREATION` (false) | Documented in `backend/.env.example` |
| Docs | `docs/runbooks/integrations.md` §11.6, §12.1–12.5, §13.2a | Exact Entra steps, permission table, admin actions, limits |

### 22.2 Tests — mocked vs real

| Test | Kind | Result |
|---|---|---|
| `backend/test/meetingPipeline.test.js` (16 tests) | **Mocked**: fake Graph, fake Google Meet, fake Jira (local HTTP), **stubbed Claude** | 16/16 — connect with/without meeting scopes; only Teams meetings synced; transcript import creates meeting, participants, link; extraction matched assignee (exact) and deadline; waiting → none after 24 h; 403 → failed with consent hint; not-organizer → none; Google entries with speaker names and calendar title; pending item refused; approved item → Jira issue with mapped assignee, due date, label, *tracks* link; duplicate refused; crash-then-retry reuses the issue (no second issue); unassignable assignee → unassigned; read-only connection refused; write scope requested only when opted in |
| `frontend/src/components/review/JiraExport.test.jsx` (5 tests) | Mocked API | 5/5 |
| Full suites | Mocked externals, real MySQL | Backend **634/634**, frontend **133/133**, build OK |
| Browser check (in-app browser, test DB) | Real API + worker code, **fake** Graph and Jira | Teams connect → granted permissions shown → "Teams meetings" resource enabled → Sync now → transcript imported → meeting page shows source, participants, VTT transcript, *same as* Teams record → Jira connected → people mapping → manual item approved → **Create Jira issue** → page shows **PAY-101**; fake Jira received assignee `acc-raj`, due 2026-11-24, labels. AI extraction was **not** exercised in the browser (no valid Anthropic key) |
| Real Microsoft Graph / Google / Atlassian / Anthropic | — | **Not run** |

### 22.3 What is still required for production activation

**Microsoft 365 (Teams)**
1. A Microsoft 365 **work/school tenant** with Teams, and an admin who can register apps and grant tenant-wide consent for delegated permissions (Global Administrator, Application Administrator or Cloud Application Administrator).
2. Entra **app registration** (single tenant), redirect URI `<APP_PUBLIC_URL>/integrations/microsoft_teams/setup`, client secret.
3. **Delegated** Microsoft Graph permissions, then **Grant admin consent**:
   - required: `User.Read`, `offline_access`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`;
   - for meetings/transcripts: `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`.
   No application permissions and no application access policy are needed for the implemented delegated flow.
4. `backend/.env`: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`; restart API and worker; Connect Teams with the account that **organizes** the meetings.
5. Teams meeting policy must allow **transcription**, and someone must start transcription in each meeting. Licensing for transcription follows the tenant's Teams plan (not verified here).
6. Run runbook §12.4 (live checklist) and record results.

**Jira issue creation**
1. Add `write:jira-work` to the Atlassian OAuth app (developer.atlassian.com).
2. `JIRA_ISSUE_CREATION=true`, restart, **Connect Jira again** (the existing connection is updated, data kept).
3. Apply migration 011 to the target database (backup first; done for the local dev DB on 2026-11-15).
4. Optional: map people (Integrations → people) so issues are assigned.
5. Live check per runbook §11.6 on a test project; delete the test issue afterwards.

**AI**: a valid Anthropic API key (the configured key returns 401), then a realistic-length extraction test.

**Known limits / not built**
- Delegated transcript access covers meetings the connected account **organized**; others are recorded as *none*.
- No Graph change notifications (polling every sync interval; import checks every 5 min).
- No write-back of status from WorkAgent to Jira after creation (Jira → WorkAgent sync works); no GitHub issue creation; no bulk export; no approval queue separate from the review page (the admin's explicit click after approval is the approval).
- Teams meetings in channels and recurring-series edge cases are untested even against fakes.

### 22.4 Updated deliverable figures

| Item | 2026-11-14 | 2026-11-15 |
|---|---|---|
| Features complete / partial / needs testing / not started / blocked | 24 / 4 / 2 / 12 / 2 | 24 / 4 / **4** / **10** / 2 |
| External write-back | none | Jira issue creation (opt-in, fake-tested) |
| Overall completion (weighted, §20.1) | ~55 % | **~60 %** — write-back & automation area moves from 0 % to ~30 % (built, not live), meeting pipeline from 75 % to ~80 % (more sources). Production readiness unchanged |

---

## 23. WorkAPI — provider-independent AI (2026-11-15)

### 23.1 Audit (before the change)

| Coupling | Where |
|---|---|
| SDK client, request shape, error mapping | `services/ai/claudeClient.js` (only module calling Anthropic) |
| Configuration | `config/index.js`: `ANTHROPIC_API_KEY/MODEL/EFFORT/MAX_OUTPUT_TOKENS/TIMEOUT_MS/REFUSAL_FALLBACK`, `AI_PRICE_*` |
| Callers | `jobs/handlers/aiExtract.js`, `services/extraction.js` (+ auto-extraction for Vexa/Teams/Meet), `worker.js` (model check), `services/ops.js` (cost) |
| Schema | `services/ai/schema.js` exported Anthropic's `output_config.format` wrapper (`OUTPUT_FORMAT`) |
| UI | `ExtractionPanel.jsx` ("set ANTHROPIC_API_KEY"), `Operations.jsx` ("set AI_PRICE_…") |
| Tests | `extraction.test.js`, `vexa.test.js`, `meetingPipeline.test.js` mocked `claude.*` |
| Docs | README, `.env.example`, roadmap/state docs |
| Provider-neutral already | prompt text, validator, assignee matcher, deadline resolver, review, transcript importers |

### 23.2 What changed

- New `backend/src/services/workapi/` (`index.js`, `providerManager.js`, `errors.js`, `retry.js`, `pricing.js`, `adapters/gemini.js`, `adapters/anthropic.js`). Contract and behaviour: `docs/WORKAPI.md`.
- `services/ai/claudeClient.js` removed; its logic lives unchanged in `adapters/anthropic.js` (except SDK retries off — WorkAPI retries centrally).
- Callers use `workapi.generateJson / verify / isConfigured / model / provider`. Prompt, schema content, validation, assignee and deadline logic unchanged; `schema.js` now exports the plain JSON Schema `OUTPUT_SCHEMA`.
- Config: `WORKAPI_PROVIDER, WORKAPI_API_KEY, WORKAPI_MODEL, WORKAPI_BASE_URL, WORKAPI_TIMEOUT (60000), WORKAPI_MAX_RETRIES, WORKAPI_MAX_OUTPUT_TOKENS, WORKAPI_PROVIDER_OPTIONS, WORKAPI_PRICE_*`, validated at startup. Old variables are ignored with a worker warning.
- Extraction runs record the model (as before) and now the provider and attempts in their summary.
- UI strings and Ops cost hint use WorkAPI variable names.
- `backend/.env` backed up to `backups/backend.env.bak-20261115-064336`, old AI lines commented out, WorkAPI block added (`WORKAPI_PROVIDER=gemini`, key and model empty → AI disabled until you add them).
- Dependency: `@google/genai` **2.32.0** pinned exactly (official googleapis SDK; 3.x was less than two weeks old).

### 23.3 Tests

| Area | Kind | Result |
|---|---|---|
| `workapi.test.js` (23) | Real SDKs, fake HTTP transport | 23/23: config validation (incl. empty values, unsupported provider, wrong options, key never printed); Gemini request shape, usage incl. thinking tokens, options; invalid/expired key → auth; unknown model; rate limit retried inline (0 s) or deferred (120 s); outages retried then given up; timeout; truncation; safety stop; blocked prompt; invalid JSON; Anthropic streaming request (effort, caching, fallback beta), options, errors (401/404/429/529), refusal, truncation; retry policy; logs contain no key/prompt/transcript; full extraction job via Gemini then via Anthropic with only settings changed |
| Existing suites | Mocked `workapi` | All pass after migrating mocks |
| Totals | — | Backend **657/657**, frontend **133/133**, build OK |
| Real Gemini | Live, 2026-11-15 | Key verified. `gemini-2.5-flash` retired for new users (404); `gemini-3.8-flash` failing on Google's side (503/504) at test time; **`gemini-3.5-flash` works**: structured output OK, and a real dev-DB transcript extracted through the unchanged prompt and validator (2 items, verified evidence, deadlines resolved, unknown owner correctly unassigned). Read-only test, nothing saved. Details: `docs/WORKAPI.md` → Live verification log |
| Real Claude | — | Not run (no valid Anthropic key) |

### 23.4 Remaining

1. ~~Live Gemini smoke test~~ done 2026-11-15. Still needed: set `WORKAPI_MODEL=gemini-3.5-flash` and `WORKAPI_TIMEOUT≈180000`, then a quality check on several long and multilingual real meetings (P0-2 of §19 now applies to Gemini). Note `workapi.verify()` can pass for retired Gemini models (models.get still lists them).
2. OpenAI adapter: not implemented (architecture ready: one adapter file + registration).
3. Ops center lists AI runs by model; it does not yet show the provider as a separate column (it is in each run's summary).
4. Historical design docs (`PLANNING.md`, `PROJECT_OVERVIEW.md`, `PHASE_3A_PLAN.md`) still describe the original Claude-only design; they are history, `docs/WORKAPI.md` is current.


## 24. Features 2–6 of the New Features Proposal (2026-11-15)

Implemented: group-based meeting invitations, conversational task and meeting orchestration, duplicate work detection, employee work metrics with privacy controls, weekly automatic digest. Feature 1 (multi-provider LLM layer) is WorkAPI, extended only with embeddings. Full description, configuration, endpoints, jobs and limits: `docs/FEATURES.md`.

- **Migrations 012–016** applied to the dev and test databases (backup `backups/meeting_action-pre-012-20261115-120326.sql`; rollback `docs/runbooks/rollback-012-016.sql`).
- **Tests:** backend 698/698 (41 new in 5 suites; 2 existing tests adjusted for intended changes: extraction jobs filter by type because a successful extraction now also queues decision extraction; employees now have four more notification kinds), frontend 141/141 (8 new), build OK.
- **Live (Gemini, test database):** assistant parse → card → confirm → undo for a meeting; a status query; duplicate adjudication; three digest narratives passing the number guard.
- **Mocked only:** Outlook/Google event creation, free/busy, Entra/Google directory sync, Jira create/update/delete for commands, Google Speech-to-Text, Teams digest webhook, Gemini embeddings.
- **Defect fixed during the work:** embedding vectors read from MySQL BLOBs could sit at an unaligned buffer offset; they are now copied before use.
- **Not done / open:** per-person calendar connections (non-admins can only send WorkAgent invitations), native distribution lists, Jira status transitions from the assistant, streaming speech, WorkAPI routing/failover/caching/golden sets.
