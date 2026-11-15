# Seed data architecture (development database)

How WorkAgent's development dataset is reset and rebuilt: what every table holds, how tables depend on each other, what the reset removes and keeps, and in which order the seed writes. Everything here was read from the migrations (`backend/src/db/migrations/001`–`019`) and the services that write each table, not assumed.

Commands (from `backend/`):

| Command | What it does |
|---|---|
| `npm run db:backup:dev` | `mysqldump` of the dev database into `backups/` (gitignored) and a check that it ends with `-- Dump completed` |
| `npm run db:reset:dev -- --confirm meeting_action --backup <file>` | Clears all organisational and transactional data (see below). Refuses unless the target is the local dev database and the backup file is complete |
| `npm run db:seed` | Builds the Arclight Labs dataset into an empty organisation. Refuses if users already exist |

## 1. Environment and safety

- Dev database: `meeting_action` on `127.0.0.1:3307` (Docker `meeting-action-mysql-1`, MySQL 8.4), from `backend/.env` (`NODE_ENV=development`). The test suite uses `meeting_action_test` and wipes it itself; the seed never touches it.
- `db:reset:dev` refuses to run when `NODE_ENV=production`, when `DB_HOST` is not `127.0.0.1`/`localhost`, when `--confirm` does not repeat `DB_NAME`, when `DB_NAME` looks like a production name, or when `--backup` does not name a readable dump of that database that ends with `-- Dump completed` and contains every current table.
- The reset is one InnoDB transaction (`DELETE`, not `TRUNCATE`, so it can roll back) with foreign-key checks **on**, in child-to-parent order. No schema change is made.
- The application's own processes (API, worker) may keep running; the reset takes row locks only. The worker's periodic jobs simply see the new data afterwards.

## 2. Table inventory

Columns marked † are NOT NULL without a default (must be provided).

### Organisation

| Table | Purpose / key columns | References |
|---|---|---|
| `users` | email† (unique), full_name†, role† `admin\|manager\|employee`, password_hash (NULL = cannot sign in), is_active, department_id, job_title, directory_source, hr_access, created_at | department → `departments` (SET NULL) |
| `user_aliases` | other names a person is called in transcripts (assignee matching) | user (CASCADE) |
| `departments` | name† (unique), source | created_by (SET NULL) |
| `teams` | name† (unique), description, lead_user_id | lead → users (RESTRICT) |
| `team_members` | (team_id, user_id) | team (CASCADE), user (RESTRICT) |
| `projects` | name† (unique), description (≤ 5000 via API), status `planning\|active\|on_hold\|completed\|archived`, owner_user_id†, start_date, target_date (CHECK target ≥ start) | owner (RESTRICT) |
| `project_members` | (project_id, user_id) | project (CASCADE), user (RESTRICT) |
| `user_groups` (+ `user_group_members`, `user_group_nesting`) | department/role/project groups are derived (`ensureDerivedGroups`); custom groups keep members | department/project (CASCADE) |
| `user_sessions`, `user_invitations`, `user_preferences` | per-person login state and settings | user (CASCADE) |

**No columns exist for**: a person's manager, skills, avatar image, joining date, team department, project priority/milestones/risks/dependencies, Jira sprint. See §6 for how the seed represents these without schema changes.

### Meetings and transcripts

| Table | Purpose | References |
|---|---|---|
| `meetings` | title†, meeting_url†, platform, native_meeting_id, scheduled/started/ended_at, status (draft … transcript_ready, review_pending, approved, emails_sent, failed), project_id, created_by† | creator (RESTRICT), project (RESTRICT) |
| `meeting_participants` | attendees | meeting/user (CASCADE) |
| `transcripts` | one per meeting: full_text, raw_json (`{source, format, …}`), segment_count | meeting (CASCADE) |
| `transcript_segments` | speaker, text, start_sec, end_sec, `vexa_segment_id`† (unique per transcript) | transcript (CASCADE) |
| `meeting_decisions` | decision text, evidence quote, segment | meeting (CASCADE), segment/user (SET NULL) |
| `extraction_runs` | one AI run per meeting (model, prompt version, tokens, summary) | meeting (CASCADE) |
| `meeting_schedules`, `meeting_invite_groups`, `meeting_invitees` | meetings WorkAgent sent invitations for | meeting (CASCADE) |
| `meeting_bot_sessions`, `vexa_webhook_events`, `meeting_transcript_imports` | Vexa bot and connector transcript imports | |

Employees see meetings and tasks only when the meeting is `approved` or `emails_sent` (`VISIBLE_MEETING_STATUSES`).

### Action items

| Table | Purpose |
|---|---|
| `action_items` | title†, description, category, meeting_id (nullable since 018), source_type (`meeting`, `teams_message`, `jira_comment`, `github_comment`, `figma_comment`, `outlook_email`, `manual`, `assistant`) + source_record_id, project/team/department, assignee (user / team / kind), due_date + deadline_status, priority `low\|medium\|high`, review_status `pending\|approved\|rejected`, task_status `todo\|in_progress\|blocked\|done`, execution_status `none\|awaiting_approval\|scheduled\|executing\|completed\|failed\|retry_required`, flags, review_details, approved_by/at, created_by |
| `action_item_evidence` | excerpt†, speaker, start_sec, segment_id (transcript) or record_id (synced record), relation `origin\|supporting\|progress\|completion` |
| `action_item_exports` | items created in Jira from WorkAgent |

UI lifecycle (services/actions/center.js): rejected → pending (needs review / extracted) → done = completed → executing/retry/failed → awaiting approval or scheduled = "scheduled" → approved. "Overdue" = open with due_date before today; "blocked" = task_status blocked.

Task completion time is **not a column**: insights, KPIs and digests read the `completed` activity (from the `task.status_changed` audit entry).

### Work graph (integrations)

| Table | Purpose |
|---|---|
| `integration_connections` | one per provider account: provider, source_instance, status `pending\|active\|suspended\|error\|disconnected`, is_enabled, settings |
| `integration_credentials` | encrypted tokens (only `vault.js` writes) |
| `integration_resources` | repository / Jira project / Figma project / Teams channel / mail folder; is_enabled, project_id (RESTRICT) |
| `integration_sync_cursors`, `webhook_deliveries`, `integration_auth_states` | sync state, inbound events, OAuth state |
| `external_identities` | people per provider; user_id when matched (email or manual) |
| `external_records` | normalised object: provider, source_instance, record_type, external_id (unique together), external_key (`ATL-104`, `org/repo#47`), parent_record_id, title, body, state, status_category, author_identity_id, project_id, metadata, content_hash† |
| `activities` | append-only timeline: dedupe_key† unique, provider, activity_type (fixed vocabulary), external_record_id or entity (meeting/action_item/project), actor, project_id, occurred_at |
| `record_links` | typed links between external records, meetings, action items and users (`implements`, `fixes`, `tracks`, `discussed_in`, `blocks`, `depends_on`, `includes`, …); origin `source\|rule\|ai\|manual`; status `suggested\|confirmed\|rejected` |
| `action_source_scans` | which records the AI source scan analysed |
| `duplicate_candidates`, `work_item_embeddings` | duplicate-work detection |
| `mock_records` | rows created by a development mock/seed, under a stable natural key |

Record types by provider (from the real mappers): GitHub `repository, issue, pull_request, comment, review, review_comment, commit`; Jira `issue, comment`; Figma `design_file, comment, version`; Teams `message, teams_meeting`; Outlook `email, calendar_event`.

### Execution, notifications, history

| Table | Purpose |
|---|---|
| `action_plans` | one approval: kind, preview (what the approver saw), status `awaiting_approval → scheduled → executing → completed\|partially_failed\|failed`, or `cancelled`/`rejected` |
| `action_executions` | one write each: idempotency_key (unique), status `awaiting_approval → scheduled → executing → succeeded\|verified\|failed\|retry_required`, or `cancelled`/`rejected`; attempts, last_error |
| `email_messages`, `email_message_items`, `email_attempts` | e-mail WorkAgent sent |
| `notifications` | in-app inbox (dedupe_key unique) |
| `audit_logs` | every change; also the source of WorkAgent's own activities (`activities:backfill`) |
| `jobs` | background queue |
| `assistant_*`, `command_invocations` | assistant history |
| `employee_metrics`, `employee_profiles`, `kpi_*` | KPI (computed only with organisation consent) |
| `weekly_digests`, `weekly_digest_recipients`, `digest_subscriptions` | weekly digests |
| `app_settings` | organisation settings (system configuration) |
| `schema_migrations` | applied migrations |

## 3. Foreign-key dependency order

Parents first (seed order); the reset deletes in reverse.

1. `departments` → `users` (department) → `user_aliases`
2. `teams`, `team_members`; `projects`, `project_members`; derived `user_groups`
3. `integration_connections` → `integration_resources` (project) → `external_identities` → `external_records` (parents before children) → `activities`, `record_links`
4. `meetings` → `meeting_participants`, `transcripts` → `transcript_segments` → `meeting_decisions`, `extraction_runs`
5. `action_items` (meeting, project, team, source record, run) → `action_item_evidence` (segment or record) → `record_links` to records
6. `audit_logs` → WorkAgent activities (`backfillFromAudit`)
7. `action_plans` → `action_executions` → `notifications`

Constraints that shape the data: `projects.target_date ≥ start_date`; `activities` must have a record or an entity; `record_links` never link a row to itself and store symmetric types once; `external_records` unique per (provider, source_instance, record_type, external_id); `action_executions.idempotency_key` unique; owners/leads/members RESTRICT user deletion (users are deleted last).

## 4. Reset strategy

Removed (everything describing the organisation and its work): users and everything per user, departments, teams, projects, groups, meetings, transcripts, decisions, extraction runs, action items and evidence, exports, plans, executions, e-mails, notifications, assistant history, digests, KPI rows, external records/identities/activities/links, source scans, duplicates, embeddings, webhook deliveries, OAuth states, jobs, audit log, mock registry, the Microsoft Teams development-mock connection with its channels, and the earlier seed connections.

Kept (system configuration and real provider connections):

- `schema_migrations` and the schema itself.
- `app_settings` (organisation settings and scheduler markers).
- **Real provider connections** (rows of `integration_connections` that are not a development mock or seed), their encrypted `integration_credentials`, their `integration_resources` and sync cursors. Their resources lose their project mapping (`project_id` → NULL, because the projects are gone); the admin re-maps them. Their synced records are removed with the rest of the work graph; the cursors are kept, so a later sync brings in only new changes.

## 5. Seed design

- **One script, dependency order, deterministic.** `backend/src/db/seeds/demo/` holds the dataset as data (people, projects, meetings with transcripts, Jira, GitHub, Figma, Teams, Outlook); `demoSeed.js` writes it in the order of §3. Every date is an offset from an anchor day (`SEED_ANCHOR_DATE`, default 2026-11-15), so the same anchor always produces the same rows, and re-anchoring moves the whole history.
- **Stable references.** Every seeded row is registered in `mock_records` (source `demo_seed`) under a natural key such as `user:koushik`, `meeting:atlas-notification-review`, `jira:ATL-104`, `item:atlas-notif-idempotency`. Re-running on a seeded database is refused (no duplicates); reset + seed rebuilds it.
- **Same shapes as real syncs.** Jira, GitHub, Figma, Teams and Outlook records are built as provider payloads and passed through the real mappers (`providers/*/mappers` / exported envelope functions) and the real `ingest()`, so records, identities, activities and provider-stated links are exactly what a real sync would store.
- **Clearly separated from real connections.** Each provider's seeded records belong to their own connection with `source_instance` `seed.arclight-labs/<provider>`, display name "<Provider> · Arclight Labs (seeded history)", `settings.mode = 'seed'`, `settings.verified = false`, and **status `disconnected`, not enabled**: nothing ever syncs, health-checks or writes to them, the AI source scan ignores them (it reads active connections only), and the Integrations page keeps showing the real connections (or "not connected"). Record URLs are left empty: no invented external links. Record pages show the standard "integration is disconnected: last synced version" note, which is accurate.
- **No AI calls.** Action items, evidence, decisions and extraction runs are written as data. Extraction runs are recorded honestly as `prompt_version = 'seed'`, model `seed-dataset`, zero tokens.
- **History through the app's own rules.** WorkAgent activities (task created/started/completed/blocked, meeting scheduled/conducted, project created) are produced by writing dated `audit_logs` entries and running the existing `backfillFromAudit`, so dashboards, insights, KPIs and digests derive everything from real rows.
- **Approvals and executions through the real engine.** Plans are created with the execution engine's `prepare`/`approve`/`reject`/`cancel`/`runPlan` for `workagent.notify` (in-app notifications, which genuinely run). Nothing is sent by e-mail, to Jira, GitHub or Teams. Pending approvals for other providers are prepared only (never executed). Timestamps are then moved to their place in the history.

## 6. Schema gaps and how they are handled (no schema changes)

| Wanted | Where it lives |
|---|---|
| Manager / reporting line | team leads (`teams.lead_user_id`) + `mock_records.metadata.managerKey` for each person; documented org chart in the report |
| Skills, joining date | `mock_records.metadata` (skills); joining date = `users.created_at` |
| Avatar | the app draws deterministic initials avatars (`UserAvatar`); no image files are needed, nothing breaks offline |
| Project priority, objective, scope, milestones, risks, dependencies, success criteria | written into the project description (plain prose, ≤ 5000 characters; the page does not render line breaks) |
| Jira sprint | issue labels (`sprint-7`) |
| Team-owned tasks | `assignee_kind = 'team'` + `assignee_team_id` |
| Task dependencies | `record_links` (`depends_on`, `blocks`) between action items |
| Department of a team | members' departments |
