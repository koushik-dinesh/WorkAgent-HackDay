# Database migrations

Migrations are plain SQL in `backend/src/db/migrations/`, applied in filename order by `npm run migrate` and recorded with a checksum in `schema_migrations`. An applied file must never change. Rollbacks are manual scripts in this folder, not migrations.

## Which database am I touching?

| Name | Used by | Notes |
|---|---|---|
| `meeting_action` | `npm run migrate`, `npm run dev`, `npm run worker` | Dev data. Back up first. |
| `meeting_action_test` | `npm test` (default `DB_TEST_NAME`) | **`npm test` migrates it automatically and every test file wipes it.** |

Host and port come from `backend/.env` (`127.0.0.1:3307`, Docker).

## Running tests without touching the shared test database

Real environment variables override `backend/.env`, so point `DB_TEST_NAME` at a throwaway database. The app user needs access to it, so create it as root:

```bash
docker exec meeting-action-mysql-1 sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot -e "CREATE DATABASE wa_tmp CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; GRANT ALL PRIVILEGES ON wa_tmp.* TO '"'"'meeting_action'"'"'@'"'"'%'"'"';"'
```

```bash
cd backend && DB_TEST_NAME=wa_tmp NODE_ENV=test MEETING_TIMEZONE=UTC node --test --test-concurrency=1 'test/**/*.test.js'
```

## Applying a migration to the dev database

1. Confirm the target: `DB_NAME` in `backend/.env` and the latest row of `schema_migrations`.
2. Back up to `backups/` (gitignored):
   ```bash
   docker exec meeting-action-mysql-1 sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysqldump -uroot --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF meeting_action' > backups/meeting_action-pre-NNN-$(date +%Y%m%d-%H%M%S).sql
   ```
3. Check the backup: it ends with `-- Dump completed`, restores into a scratch database, and row counts match per table.
4. Rehearse on that scratch copy: run `DB_NAME=<scratch> node src/db/migrate.js` from `backend/`, then the rollback script, then migrate again.
5. Stop the API and worker, run `npm run migrate`, and check tables, indexes and foreign keys in `information_schema`.
6. Restart the API and worker. **Deploy code and migration together:** new code without its tables logs errors, and scheduled jobs fail until they go dead.

Never try a rollback on the dev database to see if it works; rehearse on a copy.

## Migration log (dev database)

| Migration | Applied (UTC) | Backup | Rollback |
|---|---|---|---|
| `004_work_management.sql` | 2026-10-30 15:11 | `meeting_action-pre-004-20261030-204126.sql` | none |
| `005_integrations.sql`, `006_work_records.sql` | 2026-10-30 16:11, 16:33 | `…pre-005-…`, `…pre-006-…` | `rollback-005-006.sql` |
| `007_sync_cursor_completion.sql` | 2026-10-30 18:05 | `…pre-007-…` | none |
| `008_unified_feed_search.sql` | 2026-10-31 00:23 | `…pre-008-…` | `rollback-008.sql` |
| `009_operations_center.sql` | 2026-10-31 01:42 | `…pre-009-…` | `rollback-009.sql` |
| `010_notifications.sql` | 2026-10-31 04:23 | `meeting_action-pre-010-20261031-095201.sql` | `rollback-010.sql` |
| `011_meeting_imports_and_exports.sql` | 2026-11-15 01:03 | `meeting_action-pre-011-20261115-063243.sql` | `rollback-011.sql` |
| `017_mock_records.sql` | 2026-11-15 07:34 | `meeting_action-pre-017-20261115-*.sql` (57 tables) | `DROP TABLE mock_records` (reset the mock first) |
| `012`–`016` (features 2–6) | 2026-11-15 06:33 | `meeting_action-pre-012-20261115-120326.sql` | `rollback-012-016.sql` |
| `018_action_intelligence.sql`, `019_assistant_work_intents.sql` | 2026-11-15 09:40 | `meeting_action-pre-018-019-20261115-151050.sql` (also `…pre-018-20261115-141236.sql`) | `rollback-019.sql`, then `rollback-018.sql` |

### Migrations 018–019 record (action intelligence, `docs/ACTION_INTELLIGENCE.md`)

- **018_action_intelligence (additive):** provider rename `google_meet` → `google_calendar` in connection/record/identity/activity/delivery/command rows and the `meeting_schedules.provider` enum (no Google rows existed in dev); `action_items.meeting_id` nullable + `source_type`, `source_record_id`, `category`, `team_id`, `department_id`, `assignee_kind`, `assignee_team_id`, `deadline_status`, `due_timezone`, `created_by`, `fingerprint`, `execution_status` (existing items back-filled: source `meeting`, owner kind and deadline status from what review recorded); `action_item_evidence.record_id`, `source_url`, `occurred_at`, `relation`; new `action_source_scans`, `action_plans`, `action_executions`, `meeting_bot_sessions`, `vexa_webhook_events`; `email_messages.meeting_id` nullable + `action_execution_id`, `kind`.
- **019_assistant_work_intents:** `command_invocations.intent` gains `query_work`, `act_on_actions`.
- **Rehearsal:** a copy of the dev DB (`wa_rehearse018`) restored from the backup: migrate → `rollback-018.sql` → migrate again succeeded.
- **Applied:** after a fresh backup (ends with `-- Dump completed`). Row counts afterwards: action items 28, meetings 35, external records 70, users 43 (unchanged). The API (`--watch`) was already on the new code; **the worker started before the change was not restarted** (stopping it was not permitted in that session): it keeps working with the additive schema but does not run the new jobs (`vexa.auto_scan`, `actions.source_scan`, `action.execute`) until it is restarted.
- **Before rolling back:** roll the code back too. `rollback-018.sql` deletes action items without a meeting and execution-only e-mails (they cannot fit the old NOT NULL columns): export them first if they matter.

### Migrations 012–016 record (features 2–6, `docs/FEATURES.md`)

- **012_groups_and_scheduling:** `departments`; `users.department_id` (FK set null), `job_title`, `directory_source`, `hr_access`; `user_groups` (unique per department/project/role value and per directory id), `user_group_members`, `user_group_nesting` (no self-nesting check); `meeting_schedules` (PK meeting, times check), `meeting_invite_groups`, `meeting_invitees`.
- **013_assistant:** `assistant_conversations`, `command_invocations` (FKs to users, records, meetings, action items set null), `assistant_messages`.
- **014_duplicate_detection:** `app_settings`, `meeting_decisions`, `work_item_embeddings` (unique item + version), `duplicate_candidates` (unique pair, not-self check).
- **015_kpi:** `kpi_employee_notices`, `employee_metrics` (unique person/metric/period), `employee_profiles`, `kpi_corrections`, `kpi_access_log`.
- **016_weekly_digest:** `weekly_digests` (unique audience/scope/week), `weekly_digest_recipients`, `digest_subscriptions`.
- **Backup:** 237,286 bytes, ends with `-- Dump completed`; 35 `CREATE TABLE` (33 + the two of 011) and 30 data inserts; `schema_migrations` up to 011. (`mysqldump` warned that the app user lacks the PROCESS privilege for tablespaces; the table data is complete.)
- **Rehearsal:** the five files were applied to the test database first and the whole backend suite (698 tests) ran on it; no restore-and-rollback rehearsal on a scratch copy was done this time.
- **Applied:** 2026-11-15 06:33 UTC with `npm run migrate`; 5 files applied; users (19) and meetings (24) unchanged. No WorkAgent API or worker of the dev DB was running.
- **Before rolling back:** roll the code back too. Rolling back deletes the data of features 2–6 only (and the four new `users` columns); meetings created by the scheduler remain as ordinary meetings.

### Migration 011 record

- **Changes:** additive. New tables `meeting_transcript_imports` (PK `record_id`; index `idx_mti_due`; FK `fk_mti_record` → `external_records` cascade, `fk_mti_meeting` → `meetings` set null) and `action_item_exports` (unique `uq_aie_item_provider`; index `idx_aie_status`; FKs to `action_items` cascade, `integration_connections`, `integration_resources`, `users`, and `external_records` set null).
- **Backup:** 387,987 bytes, ends with `-- Dump completed`; restored into a scratch database, all 33 tables matched on row count.
- **Rehearsal:** on the restored copy, migrate → `rollback-011.sql` (back at 010, 33 tables) → migrate again succeeded. Scratch database dropped afterwards.
- **Applied:** no WorkAgent API or worker was running. After migrating, every pre-existing table kept its row count (only `schema_migrations` gained the 011 row). The test database was already at 011.
- **Before rolling back:** roll the code back too (transcript import and Jira export code need both tables). Rolling back loses import/export bookkeeping only; imported meetings, transcripts and created Jira issues stay.

### Migration 010 record

- **Changes:** additive. New tables `notifications` (unique `uq_notif_dedupe`; indexes `idx_notif_user`, `idx_notif_created`; FK `fk_notif_user` → `users`, cascade) and `user_preferences` (FK `fk_prefs_user` → `users`, cascade).
- **Backup:** 147,148 bytes, restored into a scratch database, all 31 tables matched on row count.
- **Rehearsal:** on the restored copy, migrate → `rollback-010.sql` (tables gone, back at 009, row counts of all 31 tables unchanged) → migrate again succeeded.
- **Test database:** `meeting_action_test` was deliberately left at 009. The next plain `npm test` will apply 010 to it.
- **Before rolling back:** roll the code back too, because Phase 10 code needs both tables. Rolling back loses all notifications and preferences.
