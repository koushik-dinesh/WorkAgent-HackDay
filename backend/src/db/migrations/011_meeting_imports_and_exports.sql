-- 011_meeting_imports_and_exports. Additive: no existing data is changed.
--
-- meeting_transcript_imports  one row per synced meeting record (Teams meeting, Google Meet
--                             conference) whose transcript WorkAgent tries to import. Tracks
--                             waiting/imported/none/failed so each meeting is fetched at most once.
-- action_item_exports         an approved action item an admin chose to create in an external
--                             tracker (Jira). One export per item and provider; holds the created
--                             issue's key so a retry never creates a second issue.
-- MySQL DDL auto-commits; statements are independent (fix forward). Rollback:
-- docs/runbooks/rollback-011.sql.

CREATE TABLE meeting_transcript_imports (
  record_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  status         ENUM('waiting','imported','none','failed') NOT NULL DEFAULT 'waiting',
  attempts       INT NOT NULL DEFAULT 0,
  meeting_id     BIGINT UNSIGNED NULL,
  -- Provider's id of the imported transcript (never its content).
  transcript_ref VARCHAR(191) NULL,
  last_error     VARCHAR(500) NULL,
  next_check_at  DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_mti_due (status, next_check_at),
  CONSTRAINT fk_mti_record FOREIGN KEY (record_id) REFERENCES external_records(id) ON DELETE CASCADE,
  CONSTRAINT fk_mti_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE action_item_exports (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action_item_id     BIGINT UNSIGNED NOT NULL,
  provider           VARCHAR(32) NOT NULL,
  connection_id      BIGINT UNSIGNED NOT NULL,
  resource_id        BIGINT UNSIGNED NOT NULL,
  status             ENUM('queued','created','failed') NOT NULL DEFAULT 'queued',
  external_key       VARCHAR(191) NULL,
  external_url       VARCHAR(2048) NULL,
  external_record_id BIGINT UNSIGNED NULL,
  -- Whether the external assignee could be set (WorkAgent user mapped to a provider account).
  assignee_set       BOOLEAN NULL,
  last_error         VARCHAR(500) NULL,
  requested_by       BIGINT UNSIGNED NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_aie_item_provider (action_item_id, provider),
  KEY idx_aie_status (status),
  CONSTRAINT fk_aie_item FOREIGN KEY (action_item_id) REFERENCES action_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_aie_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id),
  CONSTRAINT fk_aie_resource FOREIGN KEY (resource_id) REFERENCES integration_resources(id),
  CONSTRAINT fk_aie_record FOREIGN KEY (external_record_id) REFERENCES external_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_aie_requester FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
