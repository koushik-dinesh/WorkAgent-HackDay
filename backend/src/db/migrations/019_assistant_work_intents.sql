-- 019_assistant_work_intents. Additive: two new assistant intents (services/assistant/work.js).
--   query_work      read-only questions about the work graph
--   act_on_actions  bulk operations on action items through the execution engine
-- Rollback: docs/runbooks/rollback-019.sql (only if no command uses the new intents).
ALTER TABLE command_invocations
  MODIFY intent ENUM('create_meeting','assign_task','update_task','set_deadline','query_status','query_work','act_on_actions','unsupported') NULL;
