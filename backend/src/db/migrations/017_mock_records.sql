-- 017_mock_records: marker for development mock data (Microsoft Teams DEVELOPMENT MOCK,
-- docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md). Additive; no existing data is changed.
--
-- Mock data lives in the normal WorkAgent tables (users, departments, teams, projects, meetings,
-- integration records), so the application uses it like real data. This table records every row
-- the mock seed created, under a stable natural key, so that re-seeding updates instead of
-- duplicating and "Reset mock data" deletes exactly these rows and nothing else.
-- Rollback: DROP TABLE mock_records; DELETE FROM schema_migrations WHERE filename = '017_mock_records.sql';

CREATE TABLE mock_records (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Which mock produced the row, e.g. 'teams_mock'.
  source      VARCHAR(32) NOT NULL,
  -- Table-level kind: user, department, team, project, meeting, connection, group.
  entity_type VARCHAR(32) NOT NULL,
  entity_id   BIGINT UNSIGNED NOT NULL,
  -- Stable key from the fixture, e.g. 'employee:VT-001'.
  natural_key VARCHAR(191) NOT NULL,
  metadata    JSON NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mock_key (source, natural_key),
  KEY idx_mock_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
