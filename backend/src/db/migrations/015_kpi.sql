-- 015_kpi (Feature: employee KPI tracking and work profiling). Additive.
-- Settings and organisation consent live in app_settings ('kpi'). Nothing is computed for a person
-- until the organisation consented and that person acknowledged the notice.
--
-- kpi_employee_notices  the person read the profiling notice (version) before anything is computed
-- employee_metrics      deterministic metric values per person and period, with the source events
-- employee_profiles     descriptive dimensions (work pattern, role tendency, reliability band, trend)
-- kpi_corrections       events a person flagged as misattributed (excluded from their metrics)
-- kpi_access_log        every manager/HR/admin view of a person's KPIs (visible to that person)
-- MySQL DDL auto-commits; statements are independent (fix forward).

CREATE TABLE kpi_employee_notices (
  user_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  notice_version  INT NOT NULL,
  acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kpin_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE employee_metrics (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  metric_key  VARCHAR(48) NOT NULL,
  period_end  DATE NOT NULL,
  period_days SMALLINT UNSIGNED NOT NULL,
  value       DECIMAL(14,4) NULL,
  numerator   DECIMAL(14,4) NULL,
  denominator DECIMAL(14,4) NULL,
  sample_size INT NOT NULL DEFAULT 0,
  status      ENUM('ok','insufficient_data','not_observable') NOT NULL,
  details     JSON NULL,
  -- [{ type, id }] of the events this value was computed from.
  source_refs JSON NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_metric (user_id, metric_key, period_end, period_days),
  KEY idx_metric_period (period_end, metric_key),
  CONSTRAINT fk_metric_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE employee_profiles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  dimension   VARCHAR(32) NOT NULL,
  value       VARCHAR(64) NOT NULL,
  details     JSON NULL,
  period_end  DATE NOT NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_profile (user_id, dimension, period_end),
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE kpi_corrections (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id   BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(1000) NOT NULL,
  status      ENUM('excluded','restored') NOT NULL DEFAULT 'excluded',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  restored_at DATETIME NULL,
  UNIQUE KEY uq_correction (user_id, source_type, source_id),
  CONSTRAINT fk_correction_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE kpi_access_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  viewer_user_id  BIGINT UNSIGNED NULL,
  subject_user_id BIGINT UNSIGNED NULL,
  -- manager_view | hr_drilldown | admin_view | team_view | hr_aggregate
  scope           VARCHAR(32) NOT NULL,
  team_id         BIGINT UNSIGNED NULL,
  reason          VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kpil_subject (subject_user_id, created_at),
  KEY idx_kpil_viewer (viewer_user_id, created_at),
  CONSTRAINT fk_kpil_viewer FOREIGN KEY (viewer_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_kpil_subject FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
