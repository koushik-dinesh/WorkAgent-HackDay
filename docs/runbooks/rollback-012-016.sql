-- Rollback of migrations 012-016 (features 2-6). DESTRUCTIVE for the data of these features only:
-- groups, departments, scheduled-meeting bookkeeping, assistant history, duplicate candidates,
-- embeddings, meeting decisions, KPI data and digests. Existing data (users, meetings, tasks,
-- records) is untouched, except the four columns added to users.
-- Take a backup first (docs/runbooks/database-migrations.md). Run in this order (newest first).
-- Meetings created by the scheduler stay as ordinary meetings.

-- 016
DROP TABLE IF EXISTS digest_subscriptions;
DROP TABLE IF EXISTS weekly_digest_recipients;
DROP TABLE IF EXISTS weekly_digests;
-- 015
DROP TABLE IF EXISTS kpi_access_log;
DROP TABLE IF EXISTS kpi_corrections;
DROP TABLE IF EXISTS employee_profiles;
DROP TABLE IF EXISTS employee_metrics;
DROP TABLE IF EXISTS kpi_employee_notices;
-- 014
DROP TABLE IF EXISTS duplicate_candidates;
DROP TABLE IF EXISTS work_item_embeddings;
DROP TABLE IF EXISTS meeting_decisions;
DROP TABLE IF EXISTS app_settings;
-- 013
DROP TABLE IF EXISTS assistant_messages;
DROP TABLE IF EXISTS command_invocations;
DROP TABLE IF EXISTS assistant_conversations;
-- 012
DROP TABLE IF EXISTS meeting_invitees;
DROP TABLE IF EXISTS meeting_invite_groups;
DROP TABLE IF EXISTS meeting_schedules;
DROP TABLE IF EXISTS user_group_nesting;
DROP TABLE IF EXISTS user_group_members;
DROP TABLE IF EXISTS user_groups;
ALTER TABLE users
  DROP FOREIGN KEY fk_users_department,
  DROP KEY idx_users_department,
  DROP KEY idx_users_job_title,
  DROP COLUMN hr_access,
  DROP COLUMN directory_source,
  DROP COLUMN job_title,
  DROP COLUMN department_id;
DROP TABLE IF EXISTS departments;
-- Notifications of the new kinds (meeting_invited, duplicate_work, weekly_digest, kpi_viewed) can stay.
DELETE FROM schema_migrations WHERE filename IN ('012_groups_and_scheduling.sql','013_assistant.sql','014_duplicate_detection.sql','015_kpi.sql','016_weekly_digest.sql');
