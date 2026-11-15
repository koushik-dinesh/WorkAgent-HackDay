# WorkAgent — Project status (2026-11-15)

One-page summary. Action intelligence, execution and Vexa automation: `ACTION_INTELLIGENCE.md` and `integrations/VEXA_SETUP.md`. The full audit and handover is `WORKAGENT_CURRENT_STATUS_REPORT.md`; features 2–6 are in `FEATURES.md`; history is in `WORKAGENT_CURRENT_STATE.md`; the original plan is in `WORKAGENT_MASTER_ROADMAP.md`.

| Area | Status |
|---|---|
| **Action intelligence** (items from meetings, Teams, Jira/GitHub/Figma comments, Outlook; categories; owner kinds incl. teams; deadline status; one item per commitment; evidence trail; progress/completion evidence) | Complete; tested (mocked WorkAPI); **verified live on Gemini** against the Teams development-mock data (dev + test DB) |
| **Action Center** (`/actions`) and **Approvals** (`/approvals`) | Complete; tested; browser-verified (admin, verification stack on the test DB) |
| **Execution engine** (preview → approval → 60 s cancel window → idempotent execution → verification → audit; retries) | Complete. Jira create/comment/update/transition/link and e-mail: **fakes only**; Teams: **development mock** (real Graph send needs `TEAMS_MESSAGE_SEND` + consent); GitHub issues/comments: **code only** (App needs Issues: write); WorkAgent calendar + in-app: tested |
| **Follow-up automation** (reminders, overdue/no-progress/blocker escalation; e-mail only by admin policy) | Complete; tested |
| **Vexa automatic transcription** (connect once; discovery from Google Calendar/Outlook; policy + consent; one bot per meeting; lifecycle; retries; cancellations; restart recovery; signed webhooks) | Complete; tested against a fake Vexa; **connection verified live** against the local self-hosted Vexa (`GET /auth/me`); automatic dispatch into a real Meet call **not verified** |
| **Google Meet integration** | **Removed** (2026-11-15): replaced by Vexa; the Google connector is now **Google Calendar** (discovery, free/busy, events, directory) |
| Assistant on every page; work-graph questions and bulk actions (`query_work`, `act_on_actions`) | Complete; tested (mocked WorkAPI); a live parse was rate-limited by Gemini during the check |
| Light/dark themes, grouped navigation | Complete; browser-checked |
| Meeting-to-action, users, teams, projects | Complete, except password reset and manager access to meetings |
| AI extraction (WorkAPI: Gemini or Claude, by configuration) | Code complete and provider-independent (`docs/WORKAPI.md`). Local `.env` uses Gemini `gemini-3.5-flash`; live extraction checked on short transcripts only |
| WorkAPI embeddings | Built, tested with the real SDK against a fake endpoint; not configured locally (no `WORKAPI_EMBEDDING_MODEL`) |
| Integration framework, unified records, activity, search | Complete |
| Correlation and suggestions, insights, Operations | Complete (rule-based, no AI) |
| Jira Cloud, GitHub | **Connected and synced live** on the dev site/repo (small test data). Read-only live; Jira writes tested against a fake only |
| Teams (channels, meetings, transcripts), Outlook, Google Calendar connector, Figma | In code, tested against fakes only. No credentials configured |
| Write-back | Through the execution engine (see above); Jira tested against a fake only; GitHub code only |
| **Group-based meeting invitations** (feature 2) | Complete locally (groups, picker, review/confirm, WorkAgent invitations, recurring dynamic/pinned). Outlook/Google event creation, free/busy and directory sync: **fakes only** |
| **Conversational assistant** (feature 3) | Complete locally; intent parsing **verified live on Gemini**; Jira and calendar execution: **fakes only**; server speech: **fake only** (browser speech available) |
| **Duplicate work detection** (feature 4) | Complete; text-similarity mode active locally; AI adjudication **verified live on Gemini** |
| **Employee work metrics** (feature 5) | Complete with consent, notice, access log, min group size, retention, exit deletion; **off** until an admin records consent and enables it |
| **Weekly digest** (feature 6) | Complete; narrative **verified live on Gemini** with the number guard; e-mail via the existing provider (not sent live); Teams webhook: **fake only** |
| **Figma** (OAuth, files, metadata, versions, comments/replies, work-graph events) | Complete and tested against a fake Figma; **not connected for real** (no credentials). Integrations card shows *Configuration required* (`docs/integrations/FIGMA_SETUP.md`) |
| **Microsoft Teams development mock** | `TEAMS_INTEGRATION_MODE=mock`: shown CONNECTED, labelled DEVELOPMENT MOCK; fictional Violin Technologies data seeded in the dev DB (24 employees, 7 teams, 18 channels, 45 messages, 10 meetings with transcripts). Not a Microsoft connection (`docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md`) |
| Notifications, profile, preferences | Complete; email channel and automation deferred |
| Production readiness | Not done: no deployment packaging, HTTPS, CI, backups, monitoring |

**Database:** dev and test databases are at migration **019** (backup before 018/019: `backups/meeting_action-pre-018-019-20261115-151050.sql`). The dev **worker was not restarted** after 018/019 (not permitted in that session): restart it to run `vexa.auto_scan`, `actions.source_scan` and `action.execute`.

**Tests (2026-11-15, after action intelligence):** backend 769/769, frontend 156/156, production build OK.

**Repository:** `main` = `origin/main` at `6f7c2d8`; all work since (R0 fixes, Teams pipeline, WorkAPI, features 2–6) is **uncommitted**.

**Next:** restart the dev worker; activate external services (Jira write scope, Google Calendar or Outlook for Vexa discovery, `TEAMS_MESSAGE_SEND` on a real tenant, GitHub Issues: write; `ACTION_INTELLIGENCE.md` §10, `FEATURES.md` §9); verify a real Vexa dispatch into a Meet call; configure embeddings; then R1–R4 in `WORKAGENT_CURRENT_STATUS_REPORT.md` §18–19.
