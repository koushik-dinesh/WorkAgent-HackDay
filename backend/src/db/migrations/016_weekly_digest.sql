-- 016_weekly_digest (Feature: weekly automatic digest). Additive.
-- Schedule (weekday, hour, time zone) lives in app_settings ('digest').
--
-- weekly_digests            one digest per audience, scope and week: deterministic sections (data)
--                           plus an optional WorkAPI narrative that may only restate those figures
-- weekly_digest_recipients  who receives it and the delivery status per channel
-- digest_subscriptions      per person: suppressed sections and channels
-- MySQL DDL auto-commits; statements are independent (fix forward).

CREATE TABLE weekly_digests (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  audience         ENUM('manager','hr','executive') NOT NULL,
  scope_type       ENUM('team','organisation') NOT NULL,
  scope_id         BIGINT UNSIGNED NULL,
  -- 'team:<id>' or 'organisation': part of the unique key (scope_id may be NULL).
  scope_key        VARCHAR(64) NOT NULL,
  scope_name       VARCHAR(200) NOT NULL,
  period_start     DATETIME NOT NULL,
  period_end       DATETIME NOT NULL,
  status           ENUM('generating','ready','failed') NOT NULL DEFAULT 'generating',
  data             JSON NULL,
  narrative        JSON NULL,
  narrative_status ENUM('generated','not_configured','rejected','failed','skipped') NULL,
  ai_provider      VARCHAR(32) NULL,
  ai_model         VARCHAR(128) NULL,
  error            VARCHAR(1000) NULL,
  generated_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_digest (audience, scope_key, period_end),
  KEY idx_digest_period (period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE weekly_digest_recipients (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  digest_id     BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  email_status  ENUM('not_requested','queued','sent','failed','skipped') NOT NULL DEFAULT 'not_requested',
  email_error   VARCHAR(500) NULL,
  email_sent_at DATETIME NULL,
  teams_status  ENUM('not_requested','queued','sent','failed','skipped') NOT NULL DEFAULT 'not_requested',
  teams_error   VARCHAR(500) NULL,
  read_at       DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_digest_recipient (digest_id, user_id),
  KEY idx_dr_user (user_id, created_at),
  CONSTRAINT fk_dr_digest FOREIGN KEY (digest_id) REFERENCES weekly_digests(id) ON DELETE CASCADE,
  CONSTRAINT fk_dr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE digest_subscriptions (
  user_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  suppressed_sections JSON NOT NULL,
  email               BOOLEAN NOT NULL DEFAULT TRUE,
  teams               BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
