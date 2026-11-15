# Integrations runbook (Phase 3A)

Operational guide for the integration framework in one WorkAgent deployment. Design: `docs/PHASE_3A_PLAN.md`.
Everything below is per deployment (one company, one database). All commands run from `backend/` unless stated.

---

## 1. Turning integrations on

1. **Encryption key** (required before any provider that stores credentials can be used):
   ```bash
   openssl rand -base64 32
   ```
   Put the value in `backend/.env` as `CREDENTIALS_ENCRYPTION_KEY=…`.
   - Keep it outside the database and outside database backups (password manager or secret store).
   - Losing it only means stored connections must be reconnected. Synced records are not encrypted and stay.
   - The server refuses to start if the value doesn't decode to 32 bytes.
2. **Migrations:** back up first (§6), then `npm run migrate`. This applies `005_integrations.sql` and `006_work_records.sql`, which are additive.
3. **Workers.** Choose one setup:
   - One worker that runs every job type (default: `WORKER_JOB_TYPES` empty).
   - Recommended in production: two workers, so a long first sync never delays email or AI work:
     ```bash
     WORKER_JOB_TYPES=ai.extract,email.send,vexa.poll npm run worker
     WORKER_JOB_TYPES=integration.sync,integration.webhook,integration.maintenance npm run worker
     ```
   Only workers that run `integration.sync` schedule syncs. Several may run; jobs are deduplicated.
4. **Provider configuration:** each provider has its own variables (GitHub: Phase 3B). Admin → **Integrations** lists every provider and says what is missing.
5. **Trying the screens without a real provider:** `INTEGRATIONS_FAKE_PROVIDER=true` (ignored in production) adds a built-in fake provider with two repositories.

## 2. Connecting and syncing

1. Admin → Integrations → **Connect <provider>**. This goes through the provider's consent screen and back to `/integrations/<provider>/setup`.
   - The connect link works once, only for the admin who started it, for 10 minutes.
2. On the connection page:
   - Tick **Sync** for each repository/project to include. Nothing syncs by default.
   - Optionally choose a **Project**. Mind the warning: everyone who can see a project sees titles and activity of what is mapped to it.
3. Syncs run automatically:
   - Each enabled resource is re-synced every `INTEGRATION_SYNC_INTERVAL_MIN` (default 15).
   - The first sync covers `INTEGRATION_BACKFILL_DAYS` (default 90).
   - **Sync now** queues an immediate run.
4. Each sync job stops after `INTEGRATION_SYNC_CHUNK_MS` / `INTEGRATION_SYNC_CHUNK_REQUESTS` and continues later, so it never blocks other jobs.

| Connection shows | Meaning | Action |
|---|---|---|
| Health *Degraded* / *Failing* | Temporary provider errors (failing after 3 in a row) | Usually none; it recovers on the next successful sync |
| Rate limit *Paused until …* | The provider's request budget is nearly used (`INTEGRATION_RATE_LIMIT_RESERVE`) | None; resumes automatically |
| Status *Needs reconnect* | Credentials rejected or unreadable | Connect again (same account → same connection, data kept) |
| Status *Suspended* | Suspended at the provider | Unsuspend at the provider |
| Resource *access removed* | The provider no longer grants access | Re-grant at the provider, then **Refresh list** |

## 3. Webhooks

- **Endpoint:** `POST https://<public-host>/api/v1/webhooks/<provider>`.
- **What it accepts:** only correctly signed JSON, up to `WEBHOOK_MAX_BYTES` (10 MB by default). Anything else is refused and never stored.
- **Response:** `202`. Processing happens in the worker.
- **Delivery history:** shown on the connection page.
  - **Replay** re-queues a stored delivery; processing is idempotent.
  - Payloads are deleted after `WEBHOOK_PAYLOAD_RETENTION_DAYS` (default 14); the history stays. A maintenance job runs every 6 hours.
- **Missed webhooks** are not a data-loss risk: the periodic sync reconciles everything.

### Development: Cloudflare Tunnel (expose only the webhook path)

Never expose the whole API. Example `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: workagent-dev.<your-domain>
    path: ^/api/v1/webhooks/
    service: http://localhost:4000
  - service: http_status:404
```

Then run `cloudflared tunnel run <tunnel-name>`, and use `https://workagent-dev.<your-domain>/api/v1/webhooks/<provider>` as the provider's webhook URL.

Check the routing:
- `curl -i https://workagent-dev.<your-domain>/api/v1/health` must return **404**, because only the webhook path is routed.
- An unsigned POST to the webhook URL must return **401**.

The OAuth/App setup redirect goes to `APP_PUBLIC_URL` in the admin's own browser, so it doesn't need the tunnel.

## 4. Rotating the encryption key

1. Generate a new key.
2. In `backend/.env`, set `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` to the old key and `CREDENTIALS_ENCRYPTION_KEY` to the new one.
3. Restart the API and the workers. Both keys can now decrypt, and new writes use the new key. Rows are also re-encrypted as they are read.
4. Run `npm run credentials:rotate`. It re-encrypts every remaining row, is safe to repeat, and exits 1 if some rows are unreadable with both keys. Those connections must be reconnected.
5. Remove `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` and restart.

Webhook secrets are provider configuration (env). Providers accept a `…_PREVIOUS` secret during their own rotation (GitHub: Phase 3B).

## 5. Disconnecting and data

- **Disconnect:**
  - Deletes the stored credentials, tells the provider (best effort) and stops syncing.
  - Keeps the connection row and all synced records, activities and links.
  - Reconnecting the same account reuses the connection.
- **People:** `GET/PATCH /api/v1/integrations/identities` match source accounts to users. They match automatically only on an exact email, or an alias that belongs to exactly one user.
- **Deleting synced data** (retention or privacy requests) is a Phase 11 feature. Until then it is manual SQL; ask the developer.

## 6. Backup and rollback

- **Back up before every migration:**
  ```bash
  docker exec meeting-action-mysql-1 sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers meeting_action' > ../backups/meeting_action-$(date +%Y%m%d-%H%M%S).sql
  ```
  `backups/` is gitignored. Store copies elsewhere for production.
- **Code rollback:** revert the Phase 3A commits. The new tables are ignored by older code.
- **Schema rollback** (destroys all integration data): `docs/runbooks/rollback-005-006.sql`. Dry-run it on a scratch database first (§7).

## 7. Verifying an installation

```bash
cd backend && npm test        # includes the integration framework and the secret-leak regression test
cd frontend && npm test && npm run build
```

Then check:
- `GET /api/v1/integrations/providers` as an admin lists the providers you expect, as `available`.
- A worker started with `WORKER_JOB_TYPES=integration.sync` logs `integration providers` on start-up.

## 8. GitHub (Phase 3B)

WorkAgent connects to GitHub as a **GitHub App** (no personal access tokens). There is one App per deployment. Each company account the App is installed on becomes one connection.

### 8.1 Create the App (once per deployment)

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App** (on the organization, for an org-owned App).
2. Fill in the App settings:
   - **Name:** e.g. `WorkAgent <Company>`. Its URL name is the *slug* (`github.com/apps/<slug>`).
   - **Homepage URL:** the WorkAgent URL.
   - **Setup URL:** `https://<workagent-host>/integrations/github/setup`. Tick **Redirect on update**.
     - Locally this is `http://localhost:5173/integrations/github/setup`. GitHub redirects the admin's browser, so localhost works.
   - **Callback URL / "Request user authorization (OAuth) during installation":** leave empty and unticked. They are not used.
   - **Webhook:** active.
     - URL: `PUBLIC_WEBHOOK_BASE_URL/api/v1/webhooks/github`. Locally, use the Cloudflare Tunnel hostname (§3), which routes only `/api/v1/webhooks/`.
     - Secret: `openssl rand -hex 32`. This becomes `GITHUB_WEBHOOK_SECRET`.
   - **Repository permissions** (all **read-only**):
     - Metadata (mandatory)
     - Issues
     - Pull requests
     - Contents (needed for commit history; WorkAgent never downloads file contents)

     Everything else: no access.
   - **Subscribe to events:** Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Push, Repository. Installation events are always sent.
   - **Where can this App be installed:** *Only on this account* (recommended).
3. Create the App, then from its settings page:
   - note the **App ID**;
   - **Generate a private key** (a `.pem` download). Store it outside the repository with `chmod 600`.
4. Configure `backend/.env` (see `.env.example`):
   - `GITHUB_APP_ID`
   - `GITHUB_APP_SLUG`
   - `GITHUB_APP_PRIVATE_KEY_PATH` (or `GITHUB_APP_PRIVATE_KEY`)
   - `GITHUB_WEBHOOK_SECRET`
   - `PUBLIC_WEBHOOK_BASE_URL`
   - `CREDENTIALS_ENCRYPTION_KEY` (§1)

   Restart the API and the workers. The API refuses to start with a malformed private key. Admin → Integrations should now show GitHub as available, with the webhook URL to paste.

### 8.2 Connect and choose repositories

1. Admin → Integrations → **Connect GitHub**. GitHub shows the install screen: choose the account, then *All* or *Only select repositories*.
2. GitHub sends you back to WorkAgent. The installation is verified through the App's own credentials before anything is stored.
   - "An organization owner must approve…" means the installation is waiting for an org owner. Connect again once it has been approved.
3. On the connection page:
   - Tick **Sync** for each repository to include, and map it to a project.
   - New repositories granted later on GitHub arrive unticked.
   - **Manage repository access on GitHub** opens the installation settings.
4. Map people under **Integrations → People in connected applications**. GitHub accounts are never matched to users by login or name automatically.

What is synced per repository:
- repository metadata;
- issues, including open ones older than the backfill window;
- pull requests, with their reviews;
- issue/PR comments and review comments;
- default-branch commits.

Webhooks bring changes in between syncs, including commits on other branches. No file contents, diffs or archives are downloaded.

### 8.3 Rotation and revocation

| What | How |
|---|---|
| Webhook secret | Put the new secret in GitHub. Set `GITHUB_WEBHOOK_SECRET_PREVIOUS` = old and `GITHUB_WEBHOOK_SECRET` = new, then restart. Both are accepted. Remove the previous one once no old deliveries remain. |
| Private key | Generate a new key on GitHub (several can be active), switch `GITHUB_APP_PRIVATE_KEY_PATH`, restart, then delete the old key on GitHub. |
| Installation tokens | Automatic: 1-hour tokens, renewed 5 minutes before expiry and after any 401. Stored only in the encrypted vault. |
| App uninstalled on GitHub | The `installation.deleted` webhook marks the connection disconnected and deletes its credentials. Synced data stays. |
| Suspended on GitHub | The connection shows *Suspended* and syncing stops; unsuspending resumes it. |

### 8.4 Real GitHub verification procedure

Run this against a real App and a test repository. Live verification has **not** been performed yet: the automated tests use a fake GitHub over HTTP.

1. **Setup:**
   - Create the App (§8.1) with the tunnel webhook URL.
   - Create a private test repository containing:
     - 2 issues (1 closed);
     - 1 pull request with a review and a review comment;
     - an issue comment;
     - 2 commits on `main`.
2. **Configure:** set `.env` and start the API, a worker and the tunnel.
   - Check: `curl -i https://<tunnel>/api/v1/health` returns **404**.
   - Check: an unsigned `POST` to the webhook URL returns **401**.
3. **Connect:** Admin → Integrations → Connect GitHub. Install on the test repository only.
   - **Expect:** the connection is *Connected*, the repository is listed (private), and *Stored credentials* shows "installation token".
4. **First sync:** tick **Sync**, map to a project, then **Sync now**.
   - **Expect:** health *Healthy*.
   - **Expect** on the project page, under *Development*:
     - the open issue and the PR;
     - activity entries for created/closed, the review, the comments and the commits.
5. **Webhooks:**
   - **Edit** an issue title on GitHub. **Expect:** a delivery shows *Processed* within seconds and the title updates.
   - **Redeliver** the same delivery from the App's *Advanced* tab. **Expect:** no duplicate records or activities.
6. **Branch push:** push a commit to another branch. **Expect:** a commit activity with that branch.
7. **Repository access:** add a second repository to the installation on GitHub. **Expect:** it appears, unticked.
8. **Credential refresh:** revoke the installation token (or wait an hour) and **Sync now**. **Expect:** it still succeeds, because a new token is minted.
9. **Uninstall:** uninstall the App on GitHub. **Expect:** status *Disconnected*, *Stored credentials* "None", and synced data still visible.
10. **Secrets:** search the API and worker logs for `ghs_`, `BEGIN` and the webhook secret. **Expect:** no matches.
11. **Record the result:** date, App ID (not the key), and any deviations, in `docs/WORKAGENT_CURRENT_STATE.md`.

## 9. Unified activity, search and relationships (Phase 4)

- **Activity feed** (`/activity`, `GET /api/v1/activities`): WorkAgent events and connected-application events in one timeline.
  - WorkAgent events cover tasks (created, assigned, started, completed, reopened), meetings (scheduled, conducted, review completed) and projects (created, status changed).
  - Filters: project, person, source, activity type, subject type, status, date range and record. Paged with "Load more".
  - Visibility follows projects. Task events follow task visibility: members see only their own tasks; project owners and admins see all.
- **Activity vocabulary:** `backend/src/services/activities/types.js`. Connectors must use these verbs.
- **WorkAgent activities** come from the audit entry of each change (`services/audit.js` → `services/activities/internal.js`), in the same transaction.
  - History before Phase 4: run `npm run activities:backfill`. It is idempotent: a second run creates 0.
- **Record changes without a provider event** (status change, rename, deletion at the source, archival) are added by ingest, with the connectors' own key format, so they never duplicate a webhook event.
- **Search** (`/search` and the header box, `GET /api/v1/search`) covers projects, meetings, tasks and synced records.
  - Uses MySQL InnoDB FULLTEXT (migration 008). Words of 3+ letters are prefix-matched; shorter words and keys (`#12`, a commit sha) use LIKE.
  - Records deleted at the source are hidden unless `includeDeleted=true`.
- **Relationships** (Related records on record, task and meeting pages; `GET/POST/PATCH /api/v1/record-links`):
  - **Who may change them:** admins anywhere; managers when both records are in projects they manage; employees never.
  - **Removing** a relationship rejects it, so its history and provenance stay.
  - **Inferred relationships** (`origin` rule/ai) are only ever *suggested*. A person confirms or rejects them, and a rejected one is never suggested again (`services/correlation/`).
  - **GitHub-stated relationships** (origin `source`, confirmed): "Fixes/Closes/Resolves #N" in a PR or commit (same repository), and a merged PR `includes` its merge commit.
- **Source status** on record pages:
  - *deleted*: deleted at the source;
  - *disconnected* / *needs reconnect*: integration status;
  - *access removed* / *not syncing*: the repository.

  In every case the data and history are kept, and nothing is deleted automatically.
- **Retention:**
  - records, activities and relationships are kept indefinitely;
  - webhook payloads for 14 days (§3);
  - deleting synced data on request is a Phase 11 feature.
- **Rollback of 008:** `docs/runbooks/rollback-008.sql`. It only removes indexes and two relationship types.

## 10. Relationship suggestions (Phase 5)

- **What produces them:** job `correlation.evaluate`, run by the worker. It is queued (one active job per subject) when ingest inserts or updates a record, and when tasks or meetings change (approval, edit, project change, transcript, review completed).
- **Matchers** (`backend/src/services/correlation/matchers.js`):
  - *Explicit reference* — `owner/repo#12`, `PAY-42` (0.9), `#12` inside one repository (0.75).
  - *Similar wording* — an approved task and an issue/PR in the same project (0.45–0.9; +0.1 when the same person).
  - *Around a meeting* — an issue/PR created 1 day before to 3 days after a meeting of its project, about the same topic (0.45–0.8).
  - Further matchers can be added with `registerMatcher()`; they must return suggestions only.
- **Review:** `/suggestions` (admins everywhere, managers within projects they manage) or Related records on any record/task/meeting page. Confirming creates the relationship; rejecting keeps the row as rejected so it is never suggested again.
- **Nothing is ever linked automatically.** Records deleted at the source withdraw their open suggestions.
- **Re-running for everything** (after adding a matcher, or for data synced before Phase 5): `cd backend && npm run correlation:queue`. Safe to repeat: subjects that already have an active job are skipped.
- **Worker scoping:** include `correlation.evaluate` in `WORKER_JOB_TYPES` if that variable is set.
- **Rollback:** no migration. To disable, remove the handler from a worker's `WORKER_JOB_TYPES`; queued jobs stay pending. To discard open suggestions: `UPDATE record_links SET status='rejected' WHERE status='suggested' AND origin IN ('rule','ai')`.

## 11. Jira Cloud

**Status:** implemented and tested against a local fake of Atlassian's OAuth and Jira REST v3 (`backend/test/jira.test.js`, 22 tests). **Not verified against a live Jira site** — no Atlassian credentials were available.

### 11.1 Create the OAuth app (once, by an Atlassian admin)

1. developer.atlassian.com → Developer console → Create → **OAuth 2.0 integration**, e.g. "WorkAgent".
2. **Permissions → Jira API → Add**, then configure these scopes: `read:jira-work`, `read:jira-user`, and — only if issue creation will be turned on (§11.6) — `write:jira-work`. (`offline_access` is requested by WorkAgent itself so refresh tokens are issued.)
3. **Authorization → OAuth 2.0 (3LO)**: callback URL `<APP_PUBLIC_URL>/integrations/jira/setup` (e.g. `https://workagent.example.com/integrations/jira/setup`). It must match exactly.
4. **Settings**: copy the Client ID and Secret into `backend/.env` as `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET`; set `JIRA_SITE_URL` to your site (`https://<company>.atlassian.net`). Restart the API and worker.
5. While the app is in development, only its owner can consent; for other admins, set **Distribution → Sharing** on.

### 11.2 Webhooks (recommended; polling works without them)

1. Generate a secret: `openssl rand -hex 32`, set it as `JIRA_WEBHOOK_SECRET`, restart.
2. In Jira: **Settings → System → WebHooks → Create a WebHook**: URL `<PUBLIC_WEBHOOK_BASE_URL>/api/v1/webhooks/jira`, the same **Secret**, events: Issue created/updated/deleted and Comment created/updated/deleted. Optionally restrict with JQL to the synced projects.
3. Jira signs each delivery (`X-Hub-Signature: sha256=…`); unsigned or wrongly signed requests get 401 and are never stored. Deliveries are deduplicated by `X-Atlassian-Webhook-Identifier`.

### 11.3 Connect and sync

- Integrations → Jira → **Connect**. Atlassian asks for consent; choose the site in `JIRA_SITE_URL`. WorkAgent refuses grants for other sites or without offline access.
- Projects appear as resources (disabled). Tick **Sync** and map each to a WorkAgent project.
- Sync: open issues of any age plus everything updated in the backfill window, then incremental by `updated` (JQL in the API user's time zone, with a 5-minute overlap). Comments beyond those inlined in search results are fetched per issue.
- Data: issues (key `PAY-42`, status and category, assignee, labels, due date, priority, parent), comments, people (Atlassian account ids; e-mail only if the user's privacy settings share it), and links: *blocks*, *duplicates*, *relates/clones* (related) and sub-tasks (*includes*). Deleted issues and comments are marked deleted, never removed.
- `PAY-42` mentioned in GitHub, tasks or meetings is suggested as a relationship (Phase 5); Jira issues count in insights (Phase 7), including labels containing "blocked" and *blocks* links.

### 11.4 Tokens, revocation and disconnecting

- Access tokens last an hour and are refreshed automatically; Atlassian rotates the refresh token on each refresh and WorkAgent stores the new one with the access token (both encrypted).
- If the grant is revoked or the refresh token expires (90 days without use), the connection turns to **error / needs reconnect**; use Connect again — resources, mappings and data are kept.
- Disconnect deletes the stored tokens. Atlassian has no API to revoke a 3LO grant: also remove the app at **id.atlassian.com → Security → Connected apps**.
- Rate limits: HTTP 429 with `Retry-After` pauses the connection until then.

### 11.5 Live verification checklist (when credentials exist)

1. Connect; check Integrations shows the site, scopes and projects.
2. Enable one project; **Sync now**; compare issue count with `project = KEY AND (statusCategory != Done OR updated >= -90d)` in Jira.
3. Edit an issue in Jira; with webhooks on it appears within seconds (Webhook deliveries list: processed), otherwise at the next sync.
4. Revoke the app at id.atlassian.com; the next sync marks the connection *needs reconnect*.
5. Record the result in `docs/WORKAGENT_CURRENT_STATE.md`.

### 11.6 Creating Jira issues from approved action items

**Status:** implemented and tested against the local fake Jira (`backend/test/meetingPipeline.test.js`). **Not yet run against the live site.**

- **Who and when:** an admin, on a meeting's review page, for an item that is already **approved**: pick a Jira project (an enabled project resource of the Jira connection) → **Create Jira issue**. Nothing is ever created automatically.
- **Off by default.** Set `JIRA_ISSUE_CREATION=true` (restart API) only after `write:jira-work` is added to the Atlassian app (§11.1 step 2) — otherwise Atlassian rejects the Connect request. Then **Connect** Jira again (same site → the existing connection is updated, data kept). Without it WorkAgent requests read scopes exactly as before, and the button explains that the connection can only read.
- **What is sent:** summary = item title; description = item description, WorkAgent priority, source meeting and date, item id; `duedate` = the item's due date; labels `workagent` and `workagent-item-<id>`; issue type *Task* (else the first non-sub-task type). **Assignee** only when the item's owner is mapped to a Jira account (Integrations → people mapping); if Jira refuses that person, the issue is created unassigned and the page says so.
- **Idempotent:** before creating, WorkAgent searches the project for the `workagent-item-<id>` label and reuses an issue it finds, so a retry after a crash never creates a second one. One issue per item.
- **Afterwards:** the issue is ingested like a synced one, linked to the item (*tracks*, confirmed), and its status flows back with the normal sync/webhooks.
- **Failures** (missing permission, required custom fields, project gone) are shown on the item with Jira's field names; **Try again in Jira** re-queues it. Audit actions: `action_item.export_requested`, `action_item.exported`, `action_item.export_failed`.

**Live verification (when allowed to write to the real site):** reconnect with `write:jira-work`; approve a test item in a test project; Create Jira issue; check the issue in Jira (summary, due date, labels, assignee); edit its status in Jira and see it on the record page after sync; delete the test issue in Jira afterwards.

## 12. Microsoft Teams and Outlook (Microsoft Graph)

**Status:** implemented and tested against a local fake of Microsoft identity and Graph (`backend/test/microsoft.test.js`, `backend/test/meetingPipeline.test.js`). **Not verified against a live Microsoft 365 tenant** (no tenant with admin rights was available). **Change notifications (Graph subscriptions) are not implemented:** both connectors poll with delta queries on the sync interval (`INTEGRATION_SYNC_INTERVAL_MIN`).

### 12.1 Register the app (once, by an Entra administrator)

Prerequisite: a Microsoft 365 **work/school tenant** with Teams, and an account that can register apps and grant tenant-wide admin consent for **delegated** permissions (Global Administrator; Application Administrator or Cloud Application Administrator are also allowed to consent to delegated permissions). Personal Microsoft accounts cannot be used: the app is single-tenant and the Teams permissions need admin consent.

1. entra.microsoft.com → **Identity → Applications → App registrations → New registration**: name "WorkAgent", **Accounts in this organizational directory only (single tenant)**.
2. **Redirect URIs** (platform **Web**): `<APP_PUBLIC_URL>/integrations/microsoft_teams/setup` and, for Outlook, `<APP_PUBLIC_URL>/integrations/outlook/setup`. Locally: `http://localhost:5173/...` (Entra allows `http` only for `localhost`).
3. **Certificates & secrets → New client secret**; copy the **Value** once; note its expiry and put a renewal reminder in the calendar.
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** (WorkAgent acts as the signed-in account; **no application permissions** are used):

   | Permission | Needed for | Admin consent |
   |---|---|---|
   | `User.Read` | identify the signed-in account | no |
   | `offline_access` | refresh tokens | no |
   | `Team.ReadBasic.All` | list joined teams | yes |
   | `Channel.ReadBasic.All` | list channels | yes |
   | `ChannelMessage.Read.All` | channel posts and replies | yes |
   | `Calendars.Read` | *optional:* discover Teams meetings | no |
   | `OnlineMeetings.Read` | *optional:* find a meeting by its join link | no |
   | `OnlineMeetingTranscript.Read.All` | *optional:* download meeting transcripts | yes |
   | `Mail.Read`, `Calendars.Read` | Outlook connector | no |

   The first five are **required** (the connection is refused without them). The three meeting permissions are **optional as a set**: when all are granted, a "Teams meetings" resource appears and transcripts are imported (§12.5); without them channels keep working.
5. Click **Grant admin consent for <tenant>** and check every row shows *Granted*.
6. `backend/.env`: `MS_CLIENT_ID` (Application (client) ID), `MS_CLIENT_SECRET` (the secret **Value**), `MS_TENANT_ID` (Directory (tenant) ID). Restart API and worker. The worker log lists `microsoft_teams` as available.

### 12.2 What each connection is

- A connection is **one Microsoft account** of the tenant (whoever signs in on Connect). Teams sees the channels of the teams that account belongs to and that account's calendar; Outlook sees that account's mail folders and calendars. Use a dedicated service account if the data should not depend on one person.
- WorkAgent refuses grants missing the required permissions (e.g. no admin consent) and grants without offline access.
- **Teams channels:** resources are channels (`Team / Channel`). Records: channel posts and their replies (`message`), edits and deletions. Mentions like `PAY-42` or `acme/api#12` produce relationship suggestions.
- **Teams meetings:** one resource "Teams meetings (<account>)". Records: `teams_meeting` (calendar events that are Teams online meetings; subject, start/end, organizer, attendee e-mails, join link). Window: the backfill period and the next 14 days, renewed automatically.
- **Outlook:** resources are mail folders and calendars. Mail records keep subject, sender, recipients and Graph's ~255-character **preview only** — never full bodies or attachments. Calendar events keep subject, start/end, organizer, attendees, the Teams join link and status (scheduled / done / cancelled). Senders and organizers are people identified by e-mail address and matched to WorkAgent users with the same e-mail automatically.
- Deletions (Graph `@removed`) mark records deleted and keep what was stored. An expired delta token (Graph forgets them after ~7 days without sync) restarts from the backfill window. HTTP 429/503 with `Retry-After` pauses the connection.

### 12.3 Revocation and disconnecting

- Tokens: access ~1 h, refreshed automatically (asking only for the scopes that were granted); refresh tokens are replaced on each refresh. A revoked grant or expired client secret turns the connection to **needs reconnect**.
- Disconnect deletes the stored tokens. To revoke at Microsoft: Entra → Enterprise applications → WorkAgent → Permissions/Users, or the user at myaccount.microsoft.com → Apps.

### 12.4 Live verification checklist

1. Connect Teams with the service account; check channels are listed, and "Teams meetings" if the meeting permissions were granted. Enable one channel, map it, Sync now; compare messages with the channel.
2. Delete a message in Teams; after the next sync the record shows *deleted* with its text kept.
3. Hold a short Teams meeting **organized by the connected account** with **transcription turned on**; after it ends, enable "Teams meetings", Sync now, and within ~15 minutes check that a WorkAgent meeting with the transcript appears (Admin → Meetings, source "Microsoft Teams").
4. Connect Outlook; enable Inbox and Calendar; check mail previews and events (with join links).
5. Remove admin consent in Entra; the next sync marks the connection *needs reconnect*.
6. Record the result in `docs/WORKAGENT_CURRENT_STATUS_REPORT.md`.

### 12.5 Teams meeting transcripts → action items

- The worker looks every 5 minutes for `teams_meeting` records of enabled resources that ended 5 minutes to `TRANSCRIPT_IMPORT_LOOKBACK_DAYS` (default 7) days ago and queues `meeting.transcript_import`.
- Import: find the online meeting by its join link (`GET /me/onlineMeetings?$filter=JoinWebUrl eq '…'`), list its transcripts, download the newest as WebVTT, parse it with the same parser as uploads, create a WorkAgent meeting (project of the resource, participants = WorkAgent users whose e-mail is the organizer or an attendee, owner = the admin who connected), store the transcript, link meeting ↔ Teams record (*same_as*), and — with `TRANSCRIPT_AUTO_EXTRACT=true` (default) — queue AI extraction. Review, approval and e-mail stay manual.
- States per meeting (`meeting_transcript_imports`): *waiting* (no transcript yet; checked every 15 minutes for up to 24 hours after the meeting), *imported*, *none* (no transcript, or the account cannot see the meeting), *failed* (missing permission/consent: shown with the reason, not retried).
- **Limits (Microsoft):** delegated transcript access works for meetings the **connected account organized**; transcripts exist only if someone turned on **transcription** in the meeting; the tenant's Teams meeting policy must allow transcription; licensing for transcription follows the tenant's Teams plan. Channel meetings and meetings organized by other people are reported as *none*.
- An existing transcript on the WorkAgent meeting is never overwritten.
## 13. Google Calendar (formerly "Google Meet")

> **Changed 2026-11-15 (migration 018).** The standalone Google Meet integration is gone. Google Meet
> transcripts now come from the **Vexa** bot (§13.5 and `docs/integrations/VEXA_SETUP.md`); the Google
> connection is **Calendar only** and is used to *discover* meetings for automatic transcription, for
> free/busy and (opt-in) event creation, and for directory sync. Existing `google_meet` rows were
> renamed to `google_calendar`; former conference records stay as history but are no longer synced.

**Status:** tested against a local fake of Google OAuth and Calendar v3 (`backend/test/googleCalendar.test.js`). **Not verified against a live Google Workspace.** Push (Calendar watch channels) is not implemented: changes arrive with the scheduled sync.

### 13.1 Create the OAuth client (once, in Google Cloud console)

1. Create or choose a project; enable the **Google Calendar API** (the Meet REST API is no longer needed).
2. OAuth consent screen: **Internal** (Workspace users only); scopes `openid`, `email`, `…/auth/calendar.readonly` (plus `…/auth/calendar.events` if `GOOGLE_CALENDAR_WRITE=true`, and the Admin SDK read scopes if `GOOGLE_DIRECTORY_SYNC=true`).
3. Credentials → OAuth client ID → *Web application*; authorized redirect URI `<APP_PUBLIC_URL>/integrations/google_calendar/setup` (**changed** from `/google_meet/setup`: update an existing client).
4. `backend/.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_WORKSPACE_DOMAIN` (e.g. `acme.com`). Restart API and worker.

### 13.2 What is synced

- A connection is one Workspace account (whoever signs in). Accounts outside `GOOGLE_WORKSPACE_DOMAIN`, partial consent and grants without offline access are refused.
- Resources: that account's calendars. Per calendar, **events with a Google Meet link** (others are skipped): title, description (first 2,000 characters), start/end, organizer, attendee e-mails (up to 200), the account's own response (accepted/declined), all-day flag, join link; key = the Meet code. First run from the backfill window, then Google's sync token; cancelled events become *deleted*; an expired token (410) restarts from the window.
- Organizers are matched to WorkAgent users with the same e-mail.

### 13.3 Tokens and disconnecting

- Access tokens (~1 h) refresh automatically; Google refresh tokens do not rotate. A revoked grant turns the connection to *needs reconnect*.
- Disconnect revokes the grant at Google (`/revoke`, best effort) and deletes the stored tokens.

### 13.4 Live verification checklist

1. Connect with a Workspace account; calendars are listed. Enable the primary calendar and map it.
2. Sync now; Meet-link events appear with join links and attendee e-mails.
3. Cancel a Meet event; after the next sync it shows *deleted*, and its automatic-transcription session (if any) is *cancelled*.
4. Connect with a personal Gmail account: refused with the domain message.
5. Record the result in `docs/WORKAGENT_CURRENT_STATE.md`.

### 13.5 Automatic Google Meet transcription (Vexa)

Connect Vexa once on **Integrations → Vexa meeting transcription** (consent statement required). Every minute the worker (`vexa.auto_scan`) reads upcoming synced calendar events (Google Calendar and Outlook) that carry a Google Meet link, applies the organisation's policy (consent, organiser/attendee membership, opt-out keywords, declined/all-day/too long, optional internal-only), and sends the bot shortly before the start through the existing per-meeting bot flow. One bot per occurrence (unique key), retries with backoff, cancellations and reschedules followed, failures and missed meetings reported to the organiser and admins. Full setup, policy and troubleshooting: `docs/integrations/VEXA_SETUP.md`.

## 14. Figma

**Status:** implemented and tested against a local fake of Figma OAuth and REST v1 (`backend/test/figma.test.js`, 15 tests incl. the contract suite in passcode mode and end to end). **Not verified against live Figma.** Scope names follow Figma's granular OAuth scopes; confirm them in the app settings when creating the app.

### 14.1 Create the OAuth app

1. figma.com/developers → My apps → Create a new app. Callback URL: `<APP_PUBLIC_URL>/integrations/figma/setup`.
2. Scopes (updated 2026-11-15): `current_user:read`, `file_metadata:read`, `file_versions:read`, `file_comments:read`, `folders:read` — see `docs/integrations/FIGMA_SETUP.md` (the earlier `file_content:read` and `projects:read` were dropped).
3. `backend/.env`: `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET`, `FIGMA_TEAM_ID` (the number in `figma.com/files/team/<id>/…`). Restart API and worker.

### 14.2 What is synced

- One Figma team per deployment; the person who connects must be able to read it (otherwise the connection is refused). Resources: the team's projects.
- Per project: design files (name, last modified, thumbnail, link), their comments (open / resolved) and versions (named versions also appear in the activity feed; autosaves are stored but not announced). Only files modified since the last run are re-read. File contents (the design itself) are never downloaded.
- Files that disappear from a project and are gone at Figma are marked deleted (stored data kept); moved files are left alone.
- Comments mentioning `PAY-42` or `acme/api#12` produce relationship suggestions.

### 14.3 Webhooks (optional)

- Figma does not sign webhooks; it includes the passcode you chose in each payload. WorkAgent compares it in constant time and then treats the webhook only as a nudge: it takes the file key and re-reads the file, comments and versions (or confirms the deletion) from the API, so a forged or modified payload cannot inject content.
- Register (team admin, with a personal access token that has `webhooks:write`):
  ```bash
  curl -X POST https://api.figma.com/v2/webhooks -H "X-Figma-Token: <token>" -H "Content-Type: application/json" \
    -d '{"event_type":"FILE_UPDATE","team_id":"<FIGMA_TEAM_ID>","endpoint":"<PUBLIC_WEBHOOK_BASE_URL>/api/v1/webhooks/figma","passcode":"<FIGMA_WEBHOOK_PASSCODE>"}'
  ```
  Repeat for `FILE_COMMENT`, `FILE_VERSION_UPDATE` and `FILE_DELETE`.

### 14.4 Tokens and disconnecting

- Access tokens are refreshed with the refresh token (Figma does not rotate it); Figma's 403 "Invalid token" triggers one refresh and retry. A revoked app turns the connection to *needs reconnect*.
- Figma has no revocation API: disconnect deletes the stored tokens; remove the app under Figma → Settings → Security → Connected apps.

### 14.5 Live verification checklist

1. Connect; projects of the team are listed. Enable one and map it; Sync now; compare files, comments and named versions.
2. Comment in a file; with webhooks the comment appears within seconds, otherwise at the next sync.
3. Delete a file; it shows *deleted* after the webhook or next sync.
4. Record the result in `docs/WORKAGENT_CURRENT_STATE.md`.

## 15. Failure notifications

Admins get an in-app notification, at most daily per connection, when a sync finds credentials unreadable, the provider rejects them (`auth`), the installation is suspended, or another permanent provider error occurs (for example missing permissions). It links to the connection page. Transient errors and rate limits stay quiet unless the job finally goes dead, which the hourly `notifications.scan` reports to admins. See `docs/PHASE_10_NOTIFICATIONS.md`.


## 16. Calendar write, directory sync, Teams digest, speech and execution permissions

All optional and opt-in; details in `docs/FEATURES.md`. None of these has been exercised against a real tenant (tested against fakes).

| Capability | Turn on | Grant needed | Then |
|---|---|---|---|
| Outlook/Teams invitations from WorkAgent | `OUTLOOK_CALENDAR_WRITE=true` | delegated `Calendars.ReadWrite` on the Entra app | reconnect Outlook as the person who will send |
| Google Calendar/Meet invitations | `GOOGLE_CALENDAR_WRITE=true` | `https://www.googleapis.com/auth/calendar.events` on the OAuth client | reconnect Google Calendar |
| Entra ID departments, job titles, groups | `MS_DIRECTORY_SYNC=true` | delegated `User.Read.All`, `GroupMember.Read.All` (**admin consent**) | reconnect Outlook; Groups page → Sync now (daily afterwards) |
| Google Workspace directory | `GOOGLE_DIRECTORY_SYNC=true` | `admin.directory.user.readonly`, `admin.directory.group.readonly`; connect with a **Workspace admin** | reconnect Google Calendar; Sync now |
| Weekly digest to a Teams channel | `DIGEST_TEAMS_WEBHOOK_URL=<incoming webhook / Workflows URL>` | a channel webhook created by a team owner | digests post team counts + link |
| Voice commands (server) | `SPEECH_PROVIDER=google`, `SPEECH_API_KEY` | Cloud Speech-to-Text API enabled; key restricted to it | the assistant's Speak button records and transcribes |
| Assistant Jira writes | `JIRA_ISSUE_CREATION=true` (§11.6) | `write:jira-work`; each person's Jira identity linked to their user | the person's own Jira permissions are checked per action |
| Execution engine: Jira issues, comments, updates, transitions, links | `JIRA_ISSUE_CREATION=true` | `write:jira-work`; the **approver's** Jira identity linked; their Jira permissions (`CREATE_ISSUES`, `ASSIGN_ISSUES`, `ADD_COMMENTS`, `EDIT_ISSUES`, `TRANSITION_ISSUES`, `LINK_ISSUES`) are checked at approval and at execution | Action Center → Act on… → Jira; `docs/ACTION_INTELLIGENCE.md` §4 |
| Execution engine: Teams channel messages | `TEAMS_MESSAGE_SEND=true` | delegated `ChannelMessage.Send` | reconnect Teams; the development mock stores messages in WorkAgent only |
| Execution engine: GitHub issues and comments | — | GitHub App permission **Issues: Read and write** (then refresh the connection) | never commits or changes code |
| Execution engine: cancel window / bulk threshold | `ACTION_CANCEL_SECONDS` (60), `ACTION_LARGE_THRESHOLD` (10) | — | approved writes wait for the window; larger plans need a second confirmation |
| Automatic Google Meet transcription | Integrations → Vexa → Connect (consent statement) | a Google Calendar or Outlook connection for discovery; optional `VEXA_WEBHOOK_SECRET` + `VEXA_WEBHOOK_PUBLIC_URL` | `docs/integrations/VEXA_SETUP.md` |

Invitations are sent only from a connection the organiser connected themselves. Free/busy uses the organiser's connection (read access is enough).


## 17. Figma setup guide and Teams development mock

- Figma configuration, credentials and connection: `docs/integrations/FIGMA_SETUP.md` (adds `FIGMA_REDIRECT_URI`, `FIGMA_API_BASE_URL`).
- Microsoft Teams without a tenant: `TEAMS_INTEGRATION_MODE=mock` — `docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md`. The real connector (§12) is used with `real` (default).
