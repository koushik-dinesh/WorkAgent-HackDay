-- 018_action_intelligence. Additive and backward compatible; no row is deleted.
--
-- 1. Google Calendar replaces the standalone "Google Meet" connector. Google Meet transcripts now
--    come from the Vexa bot; the Google connection is kept only for calendar discovery, free/busy
--    and event creation. Existing rows are renamed google_meet -> google_calendar (meetings.platform
--    keeps 'google_meet': that is Vexa's platform name, not an integration).
-- 2. Action items from every source: meeting_id becomes optional, items carry their source record,
--    category, team/department, owner kind, deadline status, a fingerprint for cross-source
--    de-duplication and an execution status. Evidence can point at a synced record.
-- 3. Source scans: which synced records the action-item analysis has looked at (idempotency).
-- 4. Central execution engine: action_plans (one approval) and action_executions (one external
--    write each, with idempotency key, retries, external references and verification).
-- 5. E-mail history for executions reuses email_messages (meeting_id becomes optional).
-- 6. Automatic Vexa transcription: meeting_bot_sessions (calendar occurrence -> bot) and
--    vexa_webhook_events (event_id de-duplication of Vexa's at-least-once webhooks).
--
-- MySQL DDL auto-commits; statements are independent (fix forward). Rollback:
-- docs/runbooks/rollback-018.sql.

-- 1. google_meet -> google_calendar ---------------------------------------------------------------
UPDATE integration_connections SET provider = 'google_calendar' WHERE provider = 'google_meet';
UPDATE integration_auth_states SET provider = 'google_calendar' WHERE provider = 'google_meet';
UPDATE external_records SET provider = 'google_calendar' WHERE provider = 'google_meet';
UPDATE external_identities SET provider = 'google_calendar' WHERE provider = 'google_meet';
UPDATE activities SET provider = 'google_calendar' WHERE provider = 'google_meet';
UPDATE webhook_deliveries SET provider = 'google_calendar' WHERE provider = 'google_meet';
UPDATE command_invocations SET provider = 'google_calendar' WHERE provider = 'google_meet';
ALTER TABLE meeting_schedules MODIFY provider ENUM('workagent','outlook','google_meet','google_calendar') NOT NULL;
UPDATE meeting_schedules SET provider = 'google_calendar' WHERE provider = 'google_meet';
ALTER TABLE meeting_schedules MODIFY provider ENUM('workagent','outlook','google_calendar') NOT NULL;

-- 2. action items from every source ---------------------------------------------------------------
ALTER TABLE action_items
  MODIFY meeting_id BIGINT UNSIGNED NULL,
  ADD COLUMN source_type VARCHAR(32) NOT NULL DEFAULT 'meeting' AFTER extraction_run_id,
  ADD COLUMN source_record_id BIGINT UNSIGNED NULL AFTER source_type,
  ADD COLUMN category ENUM('task_assignment','follow_up','meeting_scheduling','decision_implementation','blocker_resolution',
                           'design_correction','code_implementation','review_request','deadline_change','communication_required') NULL AFTER description,
  ADD COLUMN team_id BIGINT UNSIGNED NULL AFTER project_id,
  ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER team_id,
  ADD COLUMN assignee_kind ENUM('explicit','inferred','team','unassigned') NOT NULL DEFAULT 'unassigned' AFTER assignee_match,
  ADD COLUMN assignee_team_id BIGINT UNSIGNED NULL AFTER assignee_kind,
  ADD COLUMN deadline_status ENUM('resolved','needs_clarification','none') NOT NULL DEFAULT 'none' AFTER due_date_raw,
  ADD COLUMN due_timezone VARCHAR(64) NULL AFTER deadline_status,
  ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER approved_at,
  -- sha256 of the normalised commitment (owner + verb/object words): the same commitment found in
  -- a transcript, a Teams thread and a Jira comment becomes one item with three pieces of evidence.
  ADD COLUMN fingerprint CHAR(64) NULL,
  ADD COLUMN execution_status ENUM('none','awaiting_approval','scheduled','executing','completed','failed','retry_required') NOT NULL DEFAULT 'none',
  ADD KEY idx_items_source (source_type, source_record_id),
  ADD KEY idx_items_fingerprint (fingerprint),
  ADD KEY idx_items_team (team_id),
  ADD KEY idx_items_due (due_date, task_status),
  ADD CONSTRAINT fk_items_source_record FOREIGN KEY (source_record_id) REFERENCES external_records(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_items_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_items_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_items_assignee_team FOREIGN KEY (assignee_team_id) REFERENCES teams(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_items_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- Existing items: owner kind and deadline status from what review already recorded.
UPDATE action_items
   SET assignee_kind = CASE WHEN assignee_user_id IS NULL THEN 'unassigned' WHEN assignee_match = 'fuzzy' THEN 'inferred' ELSE 'explicit' END,
       deadline_status = CASE WHEN due_date IS NOT NULL THEN 'resolved' WHEN due_date_raw IS NOT NULL THEN 'needs_clarification' ELSE 'none' END,
       created_by = COALESCE(created_by, CAST(JSON_UNQUOTE(JSON_EXTRACT(review_details, '$.createdBy')) AS UNSIGNED));

ALTER TABLE action_item_evidence
  ADD COLUMN record_id BIGINT UNSIGNED NULL AFTER segment_id,
  ADD COLUMN source_url VARCHAR(2048) NULL AFTER record_id,
  ADD COLUMN occurred_at DATETIME NULL AFTER source_url,
  ADD COLUMN relation ENUM('origin','supporting','progress','completion') NOT NULL DEFAULT 'origin' AFTER occurred_at,
  ADD KEY idx_evidence_record (record_id),
  ADD CONSTRAINT fk_evidence_record FOREIGN KEY (record_id) REFERENCES external_records(id) ON DELETE SET NULL;

-- 3. which synced records were analysed -----------------------------------------------------------
CREATE TABLE action_source_scans (
  record_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  -- Content the analysis saw; an edited message/comment is analysed again.
  content_hash   CHAR(64) NOT NULL,
  status         ENUM('pending','analysed','skipped','failed') NOT NULL DEFAULT 'pending',
  items_created  INT NOT NULL DEFAULT 0,
  items_linked   INT NOT NULL DEFAULT 0,
  reason         VARCHAR(500) NULL,
  analysed_at    DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ass_status (status, updated_at),
  CONSTRAINT fk_ass_record FOREIGN KEY (record_id) REFERENCES external_records(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 4. execution engine -----------------------------------------------------------------------------
CREATE TABLE action_plans (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind            VARCHAR(48) NOT NULL,
  title           VARCHAR(255) NOT NULL,
  origin          ENUM('action_center','assistant','followup','digest') NOT NULL DEFAULT 'action_center',
  command_id      BIGINT UNSIGNED NULL,
  status          ENUM('awaiting_approval','scheduled','executing','completed','partially_failed','failed','cancelled','rejected') NOT NULL DEFAULT 'awaiting_approval',
  -- What the person saw before approving (recipients, content, provider, counts).
  preview         JSON NOT NULL,
  preview_hash    CHAR(64) NOT NULL,
  item_count      INT NOT NULL DEFAULT 0,
  large_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  requested_by    BIGINT UNSIGNED NULL,
  approved_by     BIGINT UNSIGNED NULL,
  approved_at     DATETIME NULL,
  -- Approved plans wait until this instant before anything is written (cancel window).
  cancel_until    DATETIME NULL,
  -- 'user' = a person approved it; 'policy' = an organisation automation policy (follow-ups).
  approval_basis  ENUM('user','policy') NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_plans_status (status, created_at),
  KEY idx_plans_requester (requested_by, created_at),
  CONSTRAINT fk_plans_command FOREIGN KEY (command_id) REFERENCES command_invocations(id) ON DELETE SET NULL,
  CONSTRAINT fk_plans_requester FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_plans_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE action_executions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id            BIGINT UNSIGNED NOT NULL,
  action_item_id     BIGINT UNSIGNED NULL,
  kind               VARCHAR(48) NOT NULL,
  provider           VARCHAR(32) NOT NULL,
  connection_id      BIGINT UNSIGNED NULL,
  resource_id        BIGINT UNSIGNED NULL,
  target             JSON NULL,
  payload            JSON NOT NULL,
  payload_hash       CHAR(64) NOT NULL,
  -- sha256(kind, provider, target, action item, payload): the same write can't be planned twice.
  idempotency_key    CHAR(64) NOT NULL,
  status             ENUM('awaiting_approval','scheduled','executing','succeeded','verified','failed','retry_required','cancelled','rejected') NOT NULL DEFAULT 'awaiting_approval',
  attempts           INT NOT NULL DEFAULT 0,
  max_attempts       INT NOT NULL DEFAULT 5,
  next_attempt_at    DATETIME NULL,
  last_error         VARCHAR(1000) NULL,
  external_id        VARCHAR(191) NULL,
  external_key       VARCHAR(191) NULL,
  external_url       VARCHAR(2048) NULL,
  external_record_id BIGINT UNSIGNED NULL,
  result             JSON NULL,
  executed_at        DATETIME NULL,
  verified_at        DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_exec_idempotency (idempotency_key),
  KEY idx_exec_plan (plan_id),
  KEY idx_exec_item (action_item_id, status),
  KEY idx_exec_status (status, next_attempt_at),
  CONSTRAINT fk_exec_plan FOREIGN KEY (plan_id) REFERENCES action_plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_exec_item FOREIGN KEY (action_item_id) REFERENCES action_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_exec_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE SET NULL,
  CONSTRAINT fk_exec_resource FOREIGN KEY (resource_id) REFERENCES integration_resources(id) ON DELETE SET NULL,
  CONSTRAINT fk_exec_record FOREIGN KEY (external_record_id) REFERENCES external_records(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 5. e-mail history for executions ----------------------------------------------------------------
ALTER TABLE email_messages
  MODIFY meeting_id BIGINT UNSIGNED NULL,
  ADD COLUMN action_execution_id BIGINT UNSIGNED NULL AFTER meeting_id,
  ADD COLUMN kind VARCHAR(32) NOT NULL DEFAULT 'meeting_actions' AFTER action_execution_id,
  ADD UNIQUE KEY uq_email_execution (action_execution_id),
  ADD CONSTRAINT fk_email_execution FOREIGN KEY (action_execution_id) REFERENCES action_executions(id) ON DELETE SET NULL;

-- 6. automatic Vexa transcription -----------------------------------------------------------------
CREATE TABLE meeting_bot_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- The synced calendar event this occurrence came from (NULL for meetings created in WorkAgent).
  calendar_record_id BIGINT UNSIGNED NULL,
  meeting_id         BIGINT UNSIGNED NULL,
  platform           VARCHAR(32) NOT NULL,
  native_meeting_id  VARCHAR(255) NOT NULL,
  title              VARCHAR(255) NOT NULL,
  organizer_email    VARCHAR(255) NULL,
  organizer_user_id  BIGINT UNSIGNED NULL,
  scheduled_start    DATETIME NOT NULL,
  scheduled_end      DATETIME NULL,
  state              ENUM('scheduled','dispatching','joining','recording','processing','completed','failed','cancelled','skipped') NOT NULL DEFAULT 'scheduled',
  state_reason       VARCHAR(500) NULL,
  -- The eligibility and policy checks as they were evaluated (shown on the Vexa card).
  eligibility        JSON NULL,
  attempts           INT NOT NULL DEFAULT 0,
  next_attempt_at    DATETIME NULL,
  vexa_meeting_id    VARCHAR(64) NULL,
  dispatched_at      DATETIME NULL,
  joined_at          DATETIME NULL,
  ended_at           DATETIME NULL,
  transcript_at      DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One bot per meeting occurrence, whatever discovers it (persistent duplicate-dispatch guard).
  UNIQUE KEY uq_mbs_occurrence (platform, native_meeting_id, scheduled_start),
  KEY idx_mbs_record (calendar_record_id),
  KEY idx_mbs_state (state, next_attempt_at),
  KEY idx_mbs_meeting (meeting_id),
  CONSTRAINT fk_mbs_record FOREIGN KEY (calendar_record_id) REFERENCES external_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_mbs_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_mbs_organizer FOREIGN KEY (organizer_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE vexa_webhook_events (
  event_id      VARCHAR(100) NOT NULL PRIMARY KEY,
  event_type    VARCHAR(48) NOT NULL,
  platform      VARCHAR(32) NULL,
  native_id     VARCHAR(255) NULL,
  vexa_status   VARCHAR(32) NULL,
  outcome       VARCHAR(64) NULL,
  received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vwe_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
