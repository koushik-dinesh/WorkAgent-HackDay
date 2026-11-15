-- 012_groups_and_scheduling (Feature: department and group-based meeting invitations). Additive:
-- new tables and nullable columns; no existing data is changed.
--
-- departments             departments of the organisation (created in WorkAgent or synced from
--                         Entra ID / Google Workspace)
-- users.department_id,    directory attributes used by department and role groups; NULL for all
--   users.job_title       existing users. directory_source says who last set them.
-- users.hr_access         HR function (aggregated KPI and digest views); granted by an admin
-- user_groups             department, role, project-team and custom groups. Department, role and
--                         project groups resolve their members from users/project_members at send
--                         time; custom and directory groups keep member rows.
-- user_group_members      explicit members (custom groups, directory groups), with their source
-- user_group_nesting      groups inside custom groups (expanded recursively, cycles refused)
-- meeting_schedules       a meeting WorkAgent scheduled (calendar provider, time, recurrence,
--                         dynamic or pinned membership, send status, provider event id)
-- meeting_invite_groups   which groups were selected for a meeting (history even if the group is
--                         deleted later: no foreign key on group_id)
-- meeting_invitees        the resolved attendee list: who was invited and why (via), exclusions
-- MySQL DDL auto-commits; statements are independent (fix forward). Rollback:
-- docs/runbooks/rollback-012-016.sql.

CREATE TABLE departments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  source      ENUM('workagent','entra','google') NOT NULL DEFAULT 'workagent',
  external_id VARCHAR(191) NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_departments_name (name),
  UNIQUE KEY uq_departments_external (source, external_id),
  CONSTRAINT fk_departments_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE users
  ADD COLUMN department_id    BIGINT UNSIGNED NULL AFTER role,
  ADD COLUMN job_title        VARCHAR(200) NULL AFTER department_id,
  ADD COLUMN directory_source ENUM('manual','entra','google') NOT NULL DEFAULT 'manual' AFTER job_title,
  ADD COLUMN hr_access        BOOLEAN NOT NULL DEFAULT FALSE AFTER directory_source,
  ADD KEY idx_users_department (department_id),
  ADD KEY idx_users_job_title (job_title),
  ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;

CREATE TABLE user_groups (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  description    VARCHAR(1000) NULL,
  group_type     ENUM('department','role','project','custom') NOT NULL,
  source         ENUM('workagent','entra','google') NOT NULL DEFAULT 'workagent',
  -- The directory's group id for synced groups.
  external_id    VARCHAR(191) NULL,
  -- Exactly one of these defines a department, role or project group.
  department_id  BIGINT UNSIGNED NULL,
  role_value     VARCHAR(200) NULL,
  project_id     BIGINT UNSIGNED NULL,
  owner_user_id  BIGINT UNSIGNED NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at DATETIME NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_groups_external (source, external_id),
  UNIQUE KEY uq_groups_department (department_id),
  UNIQUE KEY uq_groups_role (role_value),
  UNIQUE KEY uq_groups_project (project_id),
  KEY idx_groups_type (group_type, is_active),
  KEY idx_groups_owner (owner_user_id),
  FULLTEXT KEY ft_groups_name (name),
  CONSTRAINT fk_groups_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
  CONSTRAINT fk_groups_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_groups_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_groups_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_group_members (
  group_id BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  source   ENUM('manual','directory') NOT NULL DEFAULT 'manual',
  added_by BIGINT UNSIGNED NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  KEY idx_ugm_user (user_id),
  CONSTRAINT fk_ugm_group FOREIGN KEY (group_id) REFERENCES user_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ugm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ugm_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_group_nesting (
  parent_group_id BIGINT UNSIGNED NOT NULL,
  child_group_id  BIGINT UNSIGNED NOT NULL,
  added_by        BIGINT UNSIGNED NULL,
  added_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (parent_group_id, child_group_id),
  KEY idx_ugn_child (child_group_id),
  CONSTRAINT chk_ugn_not_self CHECK (parent_group_id <> child_group_id),
  CONSTRAINT fk_ugn_parent FOREIGN KEY (parent_group_id) REFERENCES user_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ugn_child FOREIGN KEY (child_group_id) REFERENCES user_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ugn_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE meeting_schedules (
  meeting_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  provider          ENUM('workagent','outlook','google_meet') NOT NULL,
  connection_id     BIGINT UNSIGNED NULL,
  organizer_user_id BIGINT UNSIGNED NOT NULL,
  start_at          DATETIME NOT NULL,
  end_at            DATETIME NOT NULL,
  time_zone         VARCHAR(64) NOT NULL,
  -- { frequency: 'daily'|'weekly', interval, count } or NULL for a single meeting.
  recurrence        JSON NULL,
  membership_mode   ENUM('dynamic','pinned') NOT NULL DEFAULT 'pinned',
  status            ENUM('sending','sent','failed','cancelled') NOT NULL DEFAULT 'sending',
  external_event_id VARCHAR(512) NULL,
  external_url      VARCHAR(2048) NULL,
  join_url          VARCHAR(2048) NULL,
  -- sha256 of the confirmed attendee ids, so a changed membership is noticed before sending.
  recipients_hash   CHAR(64) NOT NULL,
  recipient_count   INT NOT NULL,
  large_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_by      BIGINT UNSIGNED NOT NULL,
  confirmed_at      DATETIME NOT NULL,
  sent_at           DATETIME NULL,
  last_resolved_at  DATETIME NULL,
  cancelled_at      DATETIME NULL,
  cancelled_by      BIGINT UNSIGNED NULL,
  last_error        VARCHAR(1000) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ms_status (status, start_at),
  KEY idx_ms_organizer (organizer_user_id, start_at),
  CONSTRAINT chk_ms_times CHECK (end_at > start_at),
  CONSTRAINT fk_ms_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_ms_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE SET NULL,
  CONSTRAINT fk_ms_organizer FOREIGN KEY (organizer_user_id) REFERENCES users(id),
  CONSTRAINT fk_ms_confirmed_by FOREIGN KEY (confirmed_by) REFERENCES users(id),
  CONSTRAINT fk_ms_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE meeting_invite_groups (
  meeting_id      BIGINT UNSIGNED NOT NULL,
  group_id        BIGINT UNSIGNED NOT NULL,
  group_name      VARCHAR(200) NOT NULL,
  group_type      VARCHAR(16) NOT NULL,
  member_count    INT NOT NULL,
  -- Pinned membership: the member ids at confirmation; dynamic: NULL (re-resolved per occurrence).
  pinned_user_ids JSON NULL,
  PRIMARY KEY (meeting_id, group_id),
  CONSTRAINT fk_mig_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE meeting_invitees (
  meeting_id  BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  email       VARCHAR(255) NOT NULL,
  -- ["individual"] and/or [{"groupId":3,"name":"Payments"}]: why this person was invited.
  via         JSON NOT NULL,
  excluded    BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_by BIGINT UNSIGNED NULL,
  added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (meeting_id, user_id),
  KEY idx_mi_user (user_id),
  CONSTRAINT fk_mi_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_mi_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mi_excluded_by FOREIGN KEY (excluded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
