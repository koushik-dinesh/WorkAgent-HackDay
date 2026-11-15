-- Rollback of 019_assistant_work_intents. Commands with the new intents must be removed or
-- relabelled first, or MySQL truncates them.
UPDATE command_invocations SET intent = 'unsupported' WHERE intent IN ('query_work', 'act_on_actions');
ALTER TABLE command_invocations
  MODIFY intent ENUM('create_meeting','assign_task','update_task','set_deadline','query_status','unsupported') NULL;
DELETE FROM schema_migrations WHERE filename = '019_assistant_work_intents.sql';
