-- Rollback of 011_meeting_imports_and_exports. Back up first (runbooks/database-migrations.md).
-- Removes import/export bookkeeping only: imported meetings, transcripts, action items, created
-- Jira issues and their record links stay. Afterwards a transcript may be imported again and an
-- item exported again (Jira lookup by the workagent-item-<id> label still prevents a duplicate).
DROP TABLE IF EXISTS action_item_exports;
DROP TABLE IF EXISTS meeting_transcript_imports;
DELETE FROM schema_migrations WHERE filename = '011_meeting_imports_and_exports.sql';
