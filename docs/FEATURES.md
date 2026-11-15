# WorkAgent — features 2–6 (group invitations, assistant, duplicate detection, work metrics, weekly digest)

Implementation of the "WorkAgent — New Features Proposal" (14 Nov 2026), features 2–6. Feature 1 (the multi-provider LLM layer) is WorkAPI (`docs/WORKAPI.md`) and was only extended with embeddings. All AI calls of these features go through WorkAPI; no feature imports a provider SDK.

Status legend used below: **tested (mocked)** = automated tests against fakes; **verified live** = exercised against the real service on 2026-11-15; **not verified** = needs credentials WorkAgent does not have.

| Feature | Local functionality | External services |
|---|---|---|
| Group invitations | Complete, tested; browser-checked | Outlook/Teams and Google Calendar event creation, free/busy, Entra/Google directory sync: **tested (mocked) only** |
| Assistant | Complete, tested; browser-checked; intent parsing **verified live on Gemini** | Jira create/update/undo: **tested (mocked)**; calendar events: **mocked**; Google Speech-to-Text: **mocked** |
| Duplicate detection | Complete, tested; adjudication **verified live on Gemini** | Gemini embeddings: **tested with the real SDK and a fake endpoint**, not live (no `WORKAPI_EMBEDDING_MODEL` set) |
| Work metrics (KPI) | Complete, tested; browser-checked | none (deterministic, no AI) |
| Weekly digest | Complete, tested; narrative **verified live on Gemini** (number guard passed) | E-mail: existing provider (SMTP/Resend) — not sent live in this run; Teams webhook: **mocked** |

## Contents
1. Group-based meeting invitations
2. Conversational task and meeting orchestration
3. Duplicate work detection
4. Employee work metrics (KPI) and profiles
5. Weekly digest
6. Database, jobs, API, configuration
7. Security and privacy
8. Testing
9. Known limitations and external blockers

---

## 1. Group-based meeting invitations

**Groups** (`/groups`, `services/groups/`):

| Type | Members | Managed by |
|---|---|---|
| Department | people whose department is it (`users.department_id`) | admins (Users page / Groups page); or Entra/Google directory sync |
| Role | people with that job title, or `app:admin` / `app:manager` / `app:employee` | admins create the group; job titles on Users page or directory |
| Project team | the project's owner and members | project page (existing) |
| Custom | explicit members + nested groups (cycles refused, nesting ≤ 10) | owner or admin; directory groups (Entra/Google) are read-only |

Membership is resolved **at send time**, only active people count, and every resolved person carries `via` (which group(s) or "individual") — stored per meeting in `meeting_invitees`, so "who was invited and why" has an answer later.

**Who can see/invite which groups:** admins and managers: all groups; employees: their own department, project teams of projects they can see, custom groups they own or are in. A group someone may not see is reported as "unknown" (no existence leak).

**Scheduling** (`/meetings/schedule`, `services/scheduling/`):
1. Pick people and groups in the combined picker (type badge, member count, expand, per-person exclusion).
2. **Review**: the server resolves the final list (de-duplicated, organiser removed, exclusions applied), shows counts per group, why each person is invited, free/busy conflicts and free slots (when you have a calendar connected), and a hash of the list.
3. **Confirm**: the client sends the hash back; the server resolves again and refuses with `409 RECIPIENTS_CHANGED` if membership changed in between. Lists or groups above `GROUP_LARGE_THRESHOLD` (default 50) also need `largeConfirmed` (`409 LARGE_CONFIRMATION_REQUIRED`).
4. A `meeting.invite_send` job creates the event **from the organiser's own calendar connection** (Outlook: Graph `POST /me/events` with a Teams link and `transactionId`; Google: `events.insert` with a Meet link, deterministic event id, `sendUpdates=all`) or, with "WorkAgent only", sends in-app invitations. A WorkAgent meeting record is created either way (participants = invitees), so transcripts and action items work as before.
5. Cancel (organiser/admin) cancels the provider event; if it fails nothing changes (`502 CALENDAR_CANCEL_FAILED`).

**Recurring meetings:** `daily`/`weekly`, 2–52 occurrences. *Pinned* keeps the confirmed list; *dynamic* re-resolves groups daily (`meeting.attendees_refresh`) and patches the event's attendees, notifying people who were added.

**Permissions for calendars:** invitations are only sent through a connection **the organiser connected themselves** (`connected_by`), with the opt-in write scope (`OUTLOOK_CALENDAR_WRITE` → `Calendars.ReadWrite`; `GOOGLE_CALENDAR_WRITE` → `calendar.events`). WorkAgent never sends as someone else. Because connecting is admin-only today, in practice only admins can send real calendar invitations; everyone else can schedule WorkAgent-only meetings (see §9).

**Directory sync** (optional, `services/groups/directorySync.js`): with `MS_DIRECTORY_SYNC=true` (Outlook connection, `User.Read.All` + `GroupMember.Read.All`, admin consent) or `GOOGLE_DIRECTORY_SYNC=true` (Admin SDK read scopes, Workspace admin account), a daily `directory.sync` job (or *Sync now* on the Groups page) creates departments, sets people's department/job title (matched by e-mail; nobody is created; values an admin set by hand win), and mirrors directory groups with members and nesting. Without it, everything works from WorkAgent data.

## 2. Conversational task and meeting orchestration

`/assistant` (`services/assistant/`). Text or voice → WorkAPI → closed intent set + strict JSON slots → code checks → entity resolution → confirmation card → execution → audit/undo.

- **Intents:** `create_meeting`, `assign_task`, `update_task`, `set_deadline`, `query_status` (anything else → "unsupported", nothing happens).
- **Never invent:** every text slot must be grounded in what the person said (its words appear in the utterance) — otherwise it is dropped; priorities/statuses/durations need their words; missing required slots produce a question, not a default.
- **Dates/times** are resolved deterministically in the person's time zone (preference, else `ORG_TIMEZONE`): "Thursday at 4 PM" → exact instant; "next Friday" or "at 4" → a choice; the model's own reading is used only when the rules do not recognise the phrase, and the card flags it ⚠.
- **Entity resolution** against WorkAgent records the person may see: people (exact/alias/first name; namesakes → choice), groups/WorkAgent teams ("the Payments department" prefers the department group), earlier meetings ("this morning's standup" → its participants), tasks (WorkAgent tasks and Jira issues; several matches → choice), Jira projects.
- **Confirmation card**: what will happen, where (provider), who is affected, assignee, due date, priority, attendees, time, warnings, and blockers that disable *Confirm*. Meeting cards can switch calendar and exclude invitees (the card is rebuilt).
- **Execution with the speaker's rights**: Jira writes require the person's **linked Jira account** to hold `CREATE_ISSUES` (+`ASSIGN_ISSUES`) / `EDIT_ISSUES` in that project (checked with Jira's permission search) and the connection to have `write:jira-work`; WorkAgent task changes require admin or project manager (assignees may change status only); meetings use the scheduling service above. The created Jira issue says "Requested by <name>"; the assignee's in-app notification carries the requester's name.
- **Work graph**: created/updated Jira issues are ingested like synced ones; meetings are WorkAgent meetings; task changes are audited (activities and notifications follow).
- **Undo** (`ASSISTANT_UNDO_SECONDS`, default 60): Jira create → delete issue (only if the person may delete issues; otherwise the card says undo is unavailable); Jira/task updates → previous values restored; meeting → cancelled (attendees get a cancellation if invites went out). A failed undo is reported as failed (`undo_failed`), never as done.
- **Audit** (`command_invocations` + `audit_logs`): utterance, input mode, intent, slots, resolution, plan, confirming user, provider, external id/key/url, result, timestamps, AI provider/model.
- **Voice**: `SPEECH_PROVIDER=google` + `SPEECH_API_KEY` → recordings (≤ ~1 min, webm/ogg/wav/flac) are transcribed by Google Cloud Speech-to-Text v1 (`services/speech/`, key in a header, audio not stored); otherwise the browser's speech recognition is used where available; the text is shown for editing before sending.

## 3. Duplicate work detection

`/duplicates`, inline alerts on record and task pages (`services/duplicates/`).

- **Items:** open Jira issues, GitHub issues and pull requests, approved WorkAgent tasks (90-day window), meeting decisions. Figma files are not work items and are not included.
- **Normalised form:** title, description, project, owner (assignee/author mapped to a WorkAgent user), labels/components, linked keys (record links, mentioned keys), files and modules named in text/branch names, incident and customer references, status, created date.
- **Similarity:** WorkAPI embeddings (`WORKAPI_EMBEDDING_*`, Gemini `batchEmbedContents`), stored per item as float32 with the version `provider:model:dims`; only same-version vectors are compared; a model change embeds again (controlled re-index; *Re-index* removes old versions). Without embeddings: deterministic TF-IDF cosine, labelled "text similarity".
- **Vector storage:** MySQL 8.4 has no vector type and the project uses MySQL, so vectors live in `work_item_embeddings` (BLOB) and search is an in-process cosine scan over the window (≤ 3,000 items). No extra infrastructure. Upgrade path for larger organisations: MySQL 9 `VECTOR` or a vector service.
- **Structure:** shared linked issue, references each other, shared files, shared modules, shared components/labels, same incident, same customer, same project.
- **Adjudication (WorkAPI, strict schema):** only for pairs with strong similarity *and* strong structure (≤ 25 per run); verdict `same` / `related` / `coincidental` + explanation; verdicts are reused, not asked again.
- **Tiers:** high = similar + strong structure + "same" → alert on both items, both owners notified once, *Link as duplicates* offered (admins / managers of both projects); medium = strong similarity, weak structure (or "related") → weekly digest; low = similarity only (or "coincidental") → stored, shown on demand. Nothing is merged or closed.
- **Triggers:** `duplicates.scan` every ~5 min for work created since the last scan ("at creation"); nightly `duplicates.sweep`; on demand: *Is anyone else working on this?* (free text or an item).
- **Feedback:** *Not a duplicate* dismisses the pair permanently; the nightly sweep raises thresholds (+0.02, max +0.1) when > 30 % of decided alerts were dismissed, lowers them slightly when < 10 %.

## 4. Employee work metrics (KPI) and profiles

`/my/kpi` (employee), `/kpi/teams/:id` (team lead), `/kpi/hr` (HR), `/admin/kpi` (admin) — `services/kpi/`.

**Off until:** an admin records the organisation's consent (statement stored and audited) **and** enables it, **and** each employee acknowledges the notice. Nothing is computed for anyone else. Changing the notice text asks everyone to acknowledge again.

**Never collected/produced:** keystrokes, screen or idle activity, after-hours tracking, a composite score, rankings, automated decisions. Every view says the metrics are advisory.

**Metrics (deterministic, nightly `kpi.compute`, 4- and 12-week periods, with source events):**

| Metric | From |
|---|---|
| Commitment reliability | tasks (and Jira issues assigned to the person) due in the period, completed on/before the due date |
| Cycle time | median assignment → completion (tasks), PR opened → merged |
| Blocker resolution time | median time the person's tasks stayed blocked |
| Review contribution | GitHub reviews/review comments, Figma comments (not observable without a linked account) |
| Collaboration breadth | distinct colleagues via meetings and reviews (+ distinct teams) |
| Rework rate | reopened tasks + reverted commits ÷ completed tasks + commits |
| Meeting-to-action conversion | meeting action items assigned in the period that are done |
| Load index | open assigned work × priority weight × age factor (≤ 30 days) |

`not_observable` and `insufficient_data` are explicit and never zero. Events flagged *Not mine* are excluded at once (recomputed) and can be restored.

**Profile (descriptive):** work pattern (items per active day: focused / mixed / fragmented), role tendency (builder / reviewer / coordinator / unblocker / specialist / mixed), reliability band (against team or job-title peers when ≥ 5, otherwise absolute thresholds — never company-wide), growth trend (4 and 12 weeks: rising / steady / declining).

**Access:** the employee sees everything about themselves, including the events and the access log. Team leads (manager role, teams they lead) see their team and members — each view is logged; a drill-down notifies the person. HR (`users.hr_access`, set by an admin) and admins see aggregates only for groups ≥ minimum size (default 5); an individual view needs a written reason (≥ 10 characters), is logged with the reason, and notifies the person.

**Retention and exit:** metrics, profiles and access logs older than the retention period (default 365 days) are deleted nightly; a deactivated person's KPI data is deleted at the next run; admins can delete it at once (`DELETE /kpi/employees/:id/data`).

## 5. Weekly digest

`/digests` (`services/digest/`). Schedule in app settings (default Friday 17:00, `ORG_TIMEZONE`), one generation per cut-off (dedupe), configurable by admins.

- **Audiences:** team digest per team for its lead; HR digest (aggregates per team, no names) for people with HR access; executive digest (cross-team and project risk) for admins.
- **Sections:** shipped (tasks completed, Jira resolved, PRs merged), slipped (overdue, days overdue, last activity), blockers, commitments at risk (due within 7 days, no activity for 7 days), decisions made (from transcripts, with time stamp), needs attention (ranked: overdue, blocked, unassigned items, overloaded people), team load (KPI engine — only when work metrics are on; HR sees load only for groups ≥ minimum size), possible duplicate work (medium/high).
- **Numbers are computed in code.** WorkAPI writes only the narrative; a narrative stating any number not present in the data is withheld (`narrative_status = rejected`) and the digest is delivered without it. Every item links to its source.
- **Delivery:** dashboard (canonical; per-person suppressed sections), e-mail through the existing provider (`EMAIL_PROVIDER`), Microsoft Teams channel via `DIGEST_TEAMS_WEBHOOK_URL` (team counts only, link to the dashboard). In-app notification for each recipient. Delivery jobs retry with backoff; status per recipient is visible to admins.

## 6. Database, jobs, API, configuration

**Migrations** (additive; rollback `docs/runbooks/rollback-012-016.sql`): `012_groups_and_scheduling`, `013_assistant`, `014_duplicate_detection`, `015_kpi`, `016_weekly_digest` — see `docs/runbooks/database-migrations.md`.

**Jobs** (existing MySQL queue: dedupe keys, retries with exponential backoff, dead jobs on the Operations page; scheduled by the existing worker loop through `services/featureSchedule.js`, daily jobs claimed once per day across workers):

| Job | When |
|---|---|
| `meeting.invite_send` | after a confirmed schedule |
| `meeting.attendees_refresh` | daily per dynamic recurring meeting |
| `directory.sync` | daily per connection with directory access; on demand |
| `duplicates.scan` / `duplicates.sweep` | every ~5 min / nightly (02:00 org time) |
| `meeting.decisions_extract` | after each successful action-item extraction |
| `kpi.compute` | nightly (01:00 org time): retention + exit deletion always; computation only with consent |
| `digest.generate` / `digest.deliver` | weekly cut-off; per recipient |

**API** (all under `/api/v1`, signed-in users; per-object rules in the services):

| Area | Endpoints |
|---|---|
| Groups | `GET/POST /groups`, `GET/PATCH/DELETE /groups/:id`, `POST /groups/:id/members`, `DELETE /groups/:id/members/:userId`, `DELETE /groups/:id/groups/:childId`, `GET /groups/directory/status`, `POST /groups/directory/sync` (admin) |
| Departments | `GET /departments`, `POST/PATCH/DELETE /departments[/:id]` (admin); users: `PATCH /users/:id` accepts `departmentId`, `jobTitle`, `hrAccess` (admin) |
| Scheduling | `GET /scheduling/calendars`, `GET /scheduling/attendees/search?q=`, `POST /scheduling/meetings/preview`, `POST /scheduling/meetings` (confirm), `GET /scheduling/meetings[/:id]`, `POST /scheduling/meetings/:id/cancel` |
| Assistant | `GET /assistant/capabilities`, `GET/DELETE /assistant/conversations[/:id]`, `POST /assistant/messages`, `POST /assistant/commands/:id/{choose,revise,confirm,cancel,undo}`, `POST /assistant/transcribe` (audio), `GET /assistant/commands` (admin audit) |
| Duplicates | `GET /duplicates?tier=&status=&itemType=&itemId=`, `GET /duplicates/:id`, `POST /duplicates/:id/{dismiss,link}`, `POST /duplicates/query`, `GET /duplicates/status`, `POST /duplicates/{sweep,reindex}` (admin) |
| Work metrics | `GET /kpi/status`, `POST /kpi/notice/acknowledge`, `GET /kpi/me`, `GET /kpi/me/sources`, `POST/DELETE /kpi/me/corrections[/:id]`, `GET /kpi/teams/:id[/members/:userId]`, `GET /kpi/hr`, `POST /kpi/hr/individual`, admin: `POST/DELETE /kpi/consent`, `PUT /kpi/settings`, `POST /kpi/compute`, `DELETE /kpi/employees/:id/data` |
| Digests | `GET /digests`, `GET /digests/:id`, `GET/PUT /digests/preferences`, admin: `GET/PUT /digests/settings`, `POST /digests/generate` |

**Configuration** (`backend/.env.example`): `WORKAPI_EMBEDDING_PROVIDER/API_KEY/MODEL/DIMENSIONS`, `OUTLOOK_CALENDAR_WRITE`, `GOOGLE_CALENDAR_WRITE`, `MS_DIRECTORY_SYNC`, `GOOGLE_DIRECTORY_SYNC`, `GROUP_LARGE_THRESHOLD`, `ORG_TIMEZONE`, `ASSISTANT_UNDO_SECONDS`, `SPEECH_PROVIDER/API_KEY/LANGUAGE/API_URL`, `DIGEST_TEAMS_WEBHOOK_URL`. Work-metrics consent/settings and the digest schedule are stored in `app_settings` and changed in the UI.

**Notification kinds added:** `meeting_invited`, `duplicate_work`, `weekly_digest`, `kpi_viewed` (each can be turned off on the Profile page).

## 7. Security and privacy

- Authentication on every route; authorization in the services (never only in the UI). IDs are always checked against what the person may see (`records/access.js` scopes); invisible objects answer 404.
- One organisation per deployment (as since Phase 3A: no tenant columns), so cross-organisation leakage is excluded by deployment; within the organisation, project/team/role visibility applies.
- No arbitrary AI actions: closed intent set, strict schemas, grounding checks, deterministic dates, confirmation before every write, exactly-once execution (atomic status claim), permission checks with the speaker's own Jira rights and calendar connection.
- Secrets: API keys only in the backend (`.env`), never logged or sent to the browser (speech key in a header; capabilities endpoint returns no secret). OAuth tokens stay in the existing encrypted vault.
- Audit entries for groups, departments, scheduling, sends, cancels, assistant parse/execute/undo/failures, duplicate decisions, KPI consent/settings/acknowledgements/flags/views/deletions, digest settings and generation.
- KPI privacy controls as listed in §4.

## 8. Testing

| Suite | Tests | Notes |
|---|---|---|
| `backend/test/groupInvitations.test.js` | 11 | groups, permissions, picker, preview/confirm, changed list, large confirmation, Outlook send/free-busy/cancel (fake Graph), dynamic refresh, Entra sync (fake) |
| `backend/test/assistant.test.js` | 10 | parser rules; WorkAPI stubbed: clarification, choices, cards, Jira permission denial, create/undo (fake Jira), failed undo, expired undo, WorkAgent task update/undo, Jira due-date update/undo, meeting create/undo, query, not configured, speech (fake endpoint) |
| `backend/test/duplicates.test.js` | 6 | normalisation, lexical mode, adjudication (stubbed), notifications, visibility, linking permissions, dismissal + tuning, versioned embeddings + re-index, real Gemini SDK embeddings against a fake endpoint |
| `backend/test/kpi.test.js` | 7 | consent gate, notice gate, metric arithmetic + sources, not observable, misattribution, team lead/HR rules, min group size, access log, notifications, retention, exit deletion |
| `backend/test/digest.test.js` | 7 | narrative guard, sections and counts, audiences, rejected narrative, idempotency, suppression, e-mail/Teams delivery (fakes), schedule |
| `frontend/src/pages/Features.test.jsx` | 8 | picker + review + large confirmation + changed list, assistant choices/card/undo/blockers/voice disabled, duplicates actions, KPI notice/sources/access log, permission-denied states, digest |

Live checks on 2026-11-15 (test database, Gemini `gemini-3.5-flash` via WorkAPI): assistant parsed "Schedule a design review with the Payments department Thursday at 4 PM for one hour" into a correct card (19 Nov 16:00 Asia/Kolkata, Payments department, 60 min), confirmed and undone; "Show me Priya Shah's overdue tasks" answered from records; duplicate adjudication returned "same" with a correct reason; three digest narratives were generated and passed the number guard.

## 9. Known limitations and external blockers

- **Microsoft 365 / Google Workspace:** no tenant or Workspace credentials are configured, so calendar event creation, free/busy, Teams links, Entra/Google directory sync and Teams transcripts are **tested against fakes only**. Activation needs: an Entra app with `Calendars.ReadWrite` (and `User.Read.All`, `GroupMember.Read.All` with admin consent for directory sync); a Google OAuth client with `calendar.events` (and Admin SDK read scopes with a Workspace admin for directory sync); set the opt-in flags and reconnect.
- **Calendar sending is per organiser connection.** Connecting integrations is admin-only today, so non-admins can schedule WorkAgent-only meetings (in-app invitations) but cannot send calendar invites until a per-person "connect my calendar" flow exists (not built: it would let personal mailboxes sync into the organisation's records, which needs a separate privacy design).
- **Native distribution lists** are not used: invitations always expand to individual attendees (the originating group is stored).
- **Jira:** the assistant needs `JIRA_ISSUE_CREATION=true` (write scope) and each person's Jira identity linked to their WorkAgent user; Jira status transitions are not supported from the assistant; the issue's reporter is the connection account (the description names the requester). Jira writes are **mocked**; the earlier live Jira connection is read-only.
- **Speech:** Google Speech-to-Text is **mocked** (no `SPEECH_API_KEY`); synchronous recognition (≤ ~1 min), not streaming. Browser speech recognition depends on the browser (Chrome/Edge).
- **Embeddings:** not configured locally (`WORKAPI_EMBEDDING_MODEL` empty) → duplicate detection runs in text-similarity mode; the Gemini embedding path is tested with the real SDK against a fake endpoint only. Brute-force search is fine for thousands of items, not millions.
- **GitHub file lists are not synced** (metadata-only by design), so "shared files" relies on paths mentioned in text and branch names.
- **KPI observability:** cycle time and reliability use WorkAgent tasks, Jira due dates/resolution and GitHub PRs; review contribution needs linked GitHub/Figma accounts; "who unblocks others" is approximated from status changes on others' blocked tasks. No calendar-based "deep focus" data is used (work pattern is items per active day).
- **Digest e-mail** uses the existing e-mail provider; with no provider configured, deliveries are marked *skipped* with the reason. Teams delivery is a channel webhook (team counts), not personal chat messages.
- **Tasks without a meeting:** WorkAgent tasks still belong to a meeting, so `assign_task` creates Jira issues (it does not create WorkAgent-only tasks).
- **Response cache, per-task routing, circuit breaker and golden-set evaluation** from the proposal's Feature 1 were not part of this scope (WorkAPI remains single-provider-at-a-time with retries).
