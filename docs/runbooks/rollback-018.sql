-- Rollback of 018_action_intelligence. Rehearse on a copy first (database-migrations.md).
-- Items without a meeting (from Teams/Jira/GitHub/Figma) and execution-only e-mails cannot fit
-- the old NOT NULL columns, so they are deleted: export them first if they matter.
DROP TABLE IF EXISTS vexa_webhook_events;
DROP TABLE IF EXISTS meeting_bot_sessions;
ALTER TABLE email_messages DROP FOREIGN KEY fk_email_execution, DROP INDEX uq_email_execution, DROP COLUMN action_execution_id, DROP COLUMN kind;
DELETE FROM email_messages WHERE meeting_id IS NULL;
ALTER TABLE email_messages DROP FOREIGN KEY fk_email_meeting;
ALTER TABLE email_messages MODIFY meeting_id BIGINT UNSIGNED NOT NULL,
  ADD CONSTRAINT fk_email_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;
DROP TABLE IF EXISTS action_executions;
DROP TABLE IF EXISTS action_plans;
DROP TABLE IF EXISTS action_source_scans;
ALTER TABLE action_item_evidence DROP FOREIGN KEY fk_evidence_record, DROP INDEX idx_evidence_record,
  DROP COLUMN record_id, DROP COLUMN source_url, DROP COLUMN occurred_at, DROP COLUMN relation;
DELETE FROM action_items WHERE meeting_id IS NULL;
ALTER TABLE action_items
  DROP FOREIGN KEY fk_items_source_record, DROP FOREIGN KEY fk_items_team, DROP FOREIGN KEY fk_items_department,
  DROP FOREIGN KEY fk_items_assignee_team, DROP FOREIGN KEY fk_items_creator;
ALTER TABLE action_items
  DROP INDEX idx_items_source, DROP INDEX idx_items_fingerprint, DROP INDEX idx_items_team, DROP INDEX idx_items_due,
  DROP INDEX fk_items_department, DROP INDEX fk_items_assignee_team, DROP INDEX fk_items_creator, DROP INDEX fk_items_source_record,
  DROP COLUMN source_type, DROP COLUMN source_record_id, DROP COLUMN category, DROP COLUMN team_id, DROP COLUMN department_id,
  DROP COLUMN assignee_kind, DROP COLUMN assignee_team_id, DROP COLUMN deadline_status, DROP COLUMN due_timezone,
  DROP COLUMN created_by, DROP COLUMN fingerprint, DROP COLUMN execution_status;
ALTER TABLE action_items DROP FOREIGN KEY fk_items_meeting;
ALTER TABLE action_items MODIFY meeting_id BIGINT UNSIGNED NOT NULL,
  ADD CONSTRAINT fk_items_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;
ALTER TABLE meeting_schedules MODIFY provider ENUM('workagent','outlook','google_meet','google_calendar') NOT NULL;
UPDATE meeting_schedules SET provider = 'google_meet' WHERE provider = 'google_calendar';
ALTER TABLE meeting_schedules MODIFY provider ENUM('workagent','outlook','google_meet') NOT NULL;
UPDATE integration_connections SET provider = 'google_meet' WHERE provider = 'google_calendar';
UPDATE integration_auth_states SET provider = 'google_meet' WHERE provider = 'google_calendar';
UPDATE external_records SET provider = 'google_meet' WHERE provider = 'google_calendar';
UPDATE external_identities SET provider = 'google_meet' WHERE provider = 'google_calendar';
UPDATE activities SET provider = 'google_meet' WHERE provider = 'google_calendar';
UPDATE webhook_deliveries SET provider = 'google_meet' WHERE provider = 'google_calendar';
UPDATE command_invocations SET provider = 'google_meet' WHERE provider = 'google_calendar';
DELETE FROM schema_migrations WHERE filename = '018_action_intelligence.sql';
