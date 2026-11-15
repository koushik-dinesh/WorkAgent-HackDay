-- 014_duplicate_detection (Feature: duplicate work detection) and meeting decisions. Additive.
--
-- app_settings           organisation-wide settings of the new features as JSON (one deployment per
--                        company): KPI consent, digest schedule, duplicate thresholds
-- meeting_decisions      decisions extracted from meeting transcripts (WorkAPI), each with a
--                        verbatim evidence quote checked against the transcript
-- work_item_embeddings   one vector per work item and embedding version ("provider:model:dims");
--                        float32 little-endian in a BLOB (MySQL 8.4 has no vector type; search is
--                        an in-process cosine scan over the 90-day window)
-- duplicate_candidates   pairs of work items that look like the same work: scores, structural
--                        evidence, AI verdict and explanation, tier, and the "not a duplicate" feedback
-- MySQL DDL auto-commits; statements are independent (fix forward).

CREATE TABLE app_settings (
  setting_key VARCHAR(64) NOT NULL PRIMARY KEY,
  value       JSON NOT NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE meeting_decisions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  meeting_id         BIGINT UNSIGNED NOT NULL,
  text               VARCHAR(1000) NOT NULL,
  decided_by_name    VARCHAR(200) NULL,
  decided_by_user_id BIGINT UNSIGNED NULL,
  evidence           TEXT NOT NULL,
  segment_id         BIGINT UNSIGNED NULL,
  start_sec          DECIMAL(10,2) NULL,
  ai_provider        VARCHAR(32) NULL,
  ai_model           VARCHAR(128) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_decisions_meeting (meeting_id),
  KEY idx_decisions_created (created_at),
  CONSTRAINT fk_decisions_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_decisions_user FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_decisions_segment FOREIGN KEY (segment_id) REFERENCES transcript_segments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE work_item_embeddings (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_type         ENUM('external_record','action_item','meeting_decision') NOT NULL,
  item_id           BIGINT UNSIGNED NOT NULL,
  embedding_version VARCHAR(191) NOT NULL,
  dimensions        SMALLINT UNSIGNED NOT NULL,
  vector            MEDIUMBLOB NOT NULL,
  -- sha256 of the normalized text; unchanged text is not embedded again.
  content_hash      CHAR(64) NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emb_item (item_type, item_id, embedding_version),
  KEY idx_emb_version (embedding_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE duplicate_candidates (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- The pair is stored once, smaller (type, id) first.
  a_type              ENUM('external_record','action_item','meeting_decision') NOT NULL,
  a_id                BIGINT UNSIGNED NOT NULL,
  b_type              ENUM('external_record','action_item','meeting_decision') NOT NULL,
  b_id                BIGINT UNSIGNED NOT NULL,
  method              ENUM('embedding','lexical') NOT NULL,
  embedding_version   VARCHAR(191) NULL,
  similarity          DECIMAL(5,4) NOT NULL,
  structural_score    DECIMAL(5,4) NOT NULL,
  structural_evidence JSON NULL,
  tier                ENUM('high','medium','low') NOT NULL,
  verdict             ENUM('same','related','coincidental') NULL,
  explanation         VARCHAR(2000) NULL,
  adjudicated_with    VARCHAR(191) NULL,
  status              ENUM('open','dismissed','linked') NOT NULL DEFAULT 'open',
  dismissed_by        BIGINT UNSIGNED NULL,
  dismissed_at        DATETIME NULL,
  dismiss_reason      VARCHAR(500) NULL,
  notified_at         DATETIME NULL,
  first_detected_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_evaluated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dup_pair (a_type, a_id, b_type, b_id),
  KEY idx_dup_b (b_type, b_id),
  KEY idx_dup_tier (tier, status, last_evaluated_at),
  CONSTRAINT chk_dup_not_self CHECK (NOT (a_type = b_type AND a_id = b_id)),
  CONSTRAINT fk_dup_dismissed_by FOREIGN KEY (dismissed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
