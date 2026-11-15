# Figma integration — setup

Status (2026-11-15): implemented and tested against a fake Figma (`backend/test/figma.test.js`, `figmaImport.test.js`). **No real Figma account has been connected** — no credentials are configured, so the Integrations page shows *Configuration required*.

## What it does

- **OAuth 2.0** (verified against developers.figma.com on 2026-11-15): authorize at `https://www.figma.com/oauth` (`response_type=code`, scopes, `state`), token exchange `POST https://api.figma.com/v1/oauth/token` and refresh `POST https://api.figma.com/v1/oauth/refresh`, both with HTTP Basic client authentication. Access tokens last 90 days and are refreshed automatically (also on a 403 "Invalid token"); Figma's refresh token is reusable (not rotated). Figma documents **no revoke endpoint**: *Disconnect* deletes the stored tokens; remove the app's access in Figma (Settings → Security → Connected apps) to revoke it there.
- **State/CSRF:** a single-use random state (stored hashed, 10 minutes, bound to the admin who started it). Tokens are stored AES-256-GCM encrypted (`CREDENTIALS_ENCRYPTION_KEY`), never sent to the browser or logged.
- **Imported:** your profile (`/v1/me`: name, e-mail — used to match you to your WorkAgent user), the configured team and its projects, files per enabled project, file metadata (`/v1/files/:key/meta`: creator, last editor, last change), the full version history (all pages of `pagination.next_page`), comments with replies and reactions.
- **Work graph:** design created (first version, attributed to the creator), design updated (each change, attributed to the last editor), design revision published (named versions), feedback provided and replies (comments). Original Figma ids, timestamps and authors are kept. People are matched to WorkAgent users by e-mail when Figma provides it (only for the connected account; others can be matched by an admin on the Integrations page). Comments that mention Jira keys (e.g. `PAY-42`) feed relationship suggestions to Jira issues; files are attached to the WorkAgent project you map each Figma project to.
- **Rate limits:** HTTP 429 with `Retry-After` pauses the connection for that long and the sync resumes; the scheduler spreads syncs. Accounts with View/Collab seats have very low monthly limits (Figma's rate-limit page).
- **Dashboard states:** *Configuration required* (says which variable is missing), *Disconnected*, *Syncing* (a sync job is queued or running), *Error* (needs reconnect / failing), *Connected* — with account, team, projects, files, versions, comments, last successful sync, *Sync now*, *Disconnect*.

## Limits from Figma's API (not WorkAgent choices)

- **Team id is required.** Figma has no API to list a user's teams ("It is not possible to programmatically obtain team IDs"). Open your team in Figma; the id is the number after `/team/` in the URL.
- Folders (Figma's new name for projects) are read with the v2 endpoints `GET /v2/teams/:team_id/folders`, `GET /v2/folders/:id/folders` (subfolders, 3 levels) and `GET /v2/folders/:id/files`. These need `folders:read` and **cannot be used by public OAuth apps** — create a **private** app.
- The team's *name* needs `teams:read` (private apps on Professional plans and above); WorkAgent does not request it and shows "Team <id>" instead.

## Scopes (exactly these — nothing more)

WorkAgent requests `current_user:read file_metadata:read file_versions:read file_comments:read folders:read`.

| Scope | Used for |
|---|---|
| `current_user:read` | `GET /v1/me` — who connected (name, e-mail for matching) |
| `file_metadata:read` | `GET /v1/files/:key/meta` — file name, creator, last editor, last change |
| `file_versions:read` | `GET /v1/files/:key/versions` — version history (and deletion check) |
| `file_comments:read` | `GET /v1/files/:key/comments` — comments, replies, reactions |
| `folders:read` | `GET /v2/teams/:id/folders`, `/v2/folders/:id/folders`, `/v2/folders/:id/files` — folders and their files |

Not requested: `file_content:read` (WorkAgent never reads a file's document tree), `projects:read` (deprecated, replaced by `folders:read`), `files:read` and `file_read` (deprecated, being removed).

**"Invalid scopes for app" (HTTP 400 on figma.com/oauth)** means the authorization asked for a scope that is not selected in your app's scope settings. Figma only allows a subset of the app's scopes. Select exactly the five scopes above on the app (step 1.3); no WorkAgent change or new credentials are needed.

## 1. Create the Figma OAuth app

1. In Figma: **Settings → Developers** (or https://www.figma.com/developers/apps) → **Create a new app**. Choose a **private** app for your team/organisation.
2. Add the redirect URL exactly: `http://localhost:5173/integrations/figma/setup` (or your `APP_PUBLIC_URL` + `/integrations/figma/setup`).
3. On the app's **OAuth scopes** page select exactly: `current_user:read`, `file_metadata:read`, `file_versions:read`, `file_comments:read`, `folders:read` (Figma asks for a short reason per scope). If you change the scopes later, people re-authorize once.
4. Copy the **Client ID** and **Client secret**.

## 2. Configure `backend/.env`

| Variable | Required | Value |
|---|---|---|
| `FIGMA_CLIENT_ID` | **yes** | the app's client id |
| `FIGMA_CLIENT_SECRET` | **yes** | the app's client secret (backend only) |
| `FIGMA_TEAM_ID` | **yes** | the numeric team id from the team's URL |
| `FIGMA_REDIRECT_URI` | yes, unless `APP_PUBLIC_URL` is set | must equal the redirect URL registered in step 1.2 |
| `CREDENTIALS_ENCRYPTION_KEY` | **yes** (already used by other integrations) | `openssl rand -base64 32` |
| `FIGMA_API_BASE_URL` | no | default `https://api.figma.com` (`FIGMA_API_URL` is the older name and still works) |
| `FIGMA_WEBHOOK_PASSCODE` | no | enables Figma webhooks (runbook §14); without it Figma is polled |

Empty values count as unset. Restart the API and the worker.

## 3. Connect and import

1. Sign in to WorkAgent as an admin → **Integrations** → Figma card → **Connect Figma**.
2. Approve in Figma with an account that belongs to the team. You return to WorkAgent; the card shows **Connected**.
3. **Projects and details** → enable the Figma projects to import and map each to a WorkAgent project.
4. **Sync now** (the worker must run: `npm run worker`). The card shows *Syncing*, then the counts and the last sync time.

## Troubleshooting

- *Configuration required: FIGMA_TEAM_ID is not set* → step 2.
- *This Figma account cannot see team …* → connect with a member of that team.
- *redirect_uri mismatch* in Figma → `FIGMA_REDIRECT_URI` must match the app's registered URL character for character.
- *Invalid scopes for app* → the app is missing one of the five scopes (see Scopes).
- Folders list empty or 403 → the app is public; the folder endpoints need a private app, or the account is not in the team.
