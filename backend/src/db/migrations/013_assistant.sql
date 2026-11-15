-- 013_assistant (Feature: conversational task and meeting orchestration). Additive.
--
-- assistant_conversations  one chat thread per person
-- assistant_messages       what the person said (text or voice transcript) and what WorkAgent answered
-- command_invocations      the audit record of every command: utterance, parsed intent and slots,
--                          entity resolution, the confirmation plan, who confirmed, what was
--                          executed where (provider, external id), undo window and outcome
-- MySQL DDL auto-commits; statements are independent (fix forward).

CREATE TABLE assistant_conversations (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  title      VARCHAR(200) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_conv_user (user_id, updated_at),
  CONSTRAINT fk_conv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE command_invocations (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id    BIGINT UNSIGNED NOT NULL,
  user_id            BIGINT UNSIGNED NOT NULL,
  utterance          TEXT NOT NULL,
  input_mode         ENUM('text','voice') NOT NULL DEFAULT 'text',
  intent             ENUM('create_meeting','assign_task','update_task','set_deadline','query_status','unsupported') NULL,
  -- Slots as the model extracted them (raw phrases; nothing defaulted).
  slots              JSON NULL,
  -- Resolved entities (user ids, group ids, dates) and open choices.
  resolution         JSON NULL,
  -- The confirmation card: exactly what will be written where.
  plan               JSON NULL,
  status             ENUM('needs_clarification','awaiting_confirmation','executing','executed','failed','cancelled','undone','undo_failed','answered','rejected') NOT NULL,
  clarification      VARCHAR(1000) NULL,
  provider           VARCHAR(32) NULL,
  external_id        VARCHAR(512) NULL,
  external_key       VARCHAR(191) NULL,
  external_url       VARCHAR(2048) NULL,
  external_record_id BIGINT UNSIGNED NULL,
  meeting_id         BIGINT UNSIGNED NULL,
  action_item_id     BIGINT UNSIGNED NULL,
  -- What undo needs (previous field values, provider event id); never secrets.
  undo_data          JSON NULL,
  undo_deadline      DATETIME NULL,
  undone_at          DATETIME NULL,
  undone_by          BIGINT UNSIGNED NULL,
  result             JSON NULL,
  error              VARCHAR(1000) NULL,
  ai_provider        VARCHAR(32) NULL,
  ai_model           VARCHAR(128) NULL,
  confirmed_by       BIGINT UNSIGNED NULL,
  confirmed_at       DATETIME NULL,
  executed_at        DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cmd_user (user_id, created_at),
  KEY idx_cmd_status (status, created_at),
  KEY idx_cmd_conversation (conversation_id, id),
  CONSTRAINT fk_cmd_conversation FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmd_record FOREIGN KEY (external_record_id) REFERENCES external_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_cmd_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_cmd_item FOREIGN KEY (action_item_id) REFERENCES action_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_cmd_confirmed_by FOREIGN KEY (confirmed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_cmd_undone_by FOREIGN KEY (undone_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE assistant_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NOT NULL,
  role            ENUM('user','assistant') NOT NULL,
  content         TEXT NOT NULL,
  input_mode      ENUM('text','voice') NULL,
  command_id      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_msg_conversation (conversation_id, id),
  CONSTRAINT fk_msg_conversation FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_command FOREIGN KEY (command_id) REFERENCES command_invocations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
