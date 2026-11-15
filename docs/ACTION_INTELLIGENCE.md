# Action intelligence and execution — architecture

How WorkAgent turns what it collects into action items, and action items into approved, traceable
writes in connected applications. Implemented 2026-11-15 against the *Full Platform Proposal*
(14 Nov 2026). Companion documents: `docs/integrations/VEXA_SETUP.md` (meeting transcription),
`docs/FEATURES.md` (groups, assistant, duplicates, KPIs, digest), `docs/WORKAPI.md` (AI layer).

Status legend: **tested (mocked)** = automated tests against fakes; **verified live** = run against
the real service on 2026-11-15; **not verified** = needs credentials or access WorkAgent does not have.

## 1. Pipeline

```
connectors (Teams, Jira, GitHub, Figma, Outlook, Google Calendar) + Vexa transcripts + uploads
   │  existing ingestion: normalised external_records, activities, identities (Phase 3A/4)
   ▼
correlation engine (existing, rule-based: keys, wording, meeting window) → record_links
   ▼                                                   ▲
action-item analysis                                   │ links created by executions
   meetings: ai.extract (existing prompt + validator)  │ (confirmed, origin 'source')
   other sources: actions.source_scan (new)            │
   ▼                                                   │
deterministic enrichment: category · owner kind · team owner · deadline status · fingerprint
   ▼
one item per commitment (fingerprint / near-duplicate → evidence added, not a new item)
   ▼
Action Center review (edit owner/deadline/category, resolve flags, approve/reject)
   ▼
execution engine: plan → exact preview → approval → cancel window → execute → verify → audit
   ▼
write-back (Jira, e-mail, Teams, GitHub, calendar, in-app) linked into the work graph
   ▼
progress/completion evidence from linked work · follow-up automation · weekly digest
```

All AI calls go through WorkAPI (Gemini or Claude by configuration). Everything after the model —
validation, owners, deadlines, de-duplication, permissions, execution — is deterministic code.

## 2. Action items from every source

**Meetings** (existing): transcript → WorkAPI → `validator.js` (verbatim evidence, owner must be
said and match the directory, deadline words must be said) → **new** `enrichItems` (category,
owner kind, team owner, deadline status, fingerprint) → pending review.

**Other sources** (`services/actions/sourceExtraction.js`, job `actions.source_scan`, every ~5 min):

| Source | Records analysed | Used as evidence only |
|---|---|---|
| Microsoft Teams | channel messages and replies (thread = root + replies) | — |
| Jira | comments (with the issue as context) | issues (status → progress/completion) |
| GitHub | comments, reviews, review comments (with the issue/PR as context) | issues, PRs (merged → completion), commits |
| Figma | comments (with the file as context) | files, versions |
| Outlook | e-mails | — |

- A deterministic pre-filter skips records without commitment, request, deadline or blocker
  language (no AI call). Each record's content hash is stored (`action_source_scans`); a record is
  analysed again only when edited, and re-analysis merges into existing items.
- The prompt marks message text as untrusted data; the response must match a strict JSON schema;
  the existing validator rejects items whose quote is not verbatim in a message and refuses owners
  whose name is not in the text.
- Jira issues, PRs, commits and Figma versions are already work items: they are **never** turned into
  new action items, only linked as evidence.

**Categories** (closed set): task assignment, follow-up, meeting scheduling, decision implementation,
blocker resolution, design correction, code implementation, review request, deadline change,
communication required. The model may propose one; an unknown value falls back to keyword rules.

**Owners** — never invented:

| Kind | When |
|---|---|
| `explicit` | full name or alias matched one active user, or a reviewer chose the person |
| `inferred` | first-name-only match, or the model said the owner was only implied |
| `team` | a team/department was named ("the design team"); resolved against WorkAgent teams and departments; ambiguous teams stay unresolved |
| `unassigned` | nobody, or the name matched several people (`ambiguous_assignee`, candidates shown) or nobody |

Approval always needs a person: a team-owned item is approved after a reviewer picks the person.

**Deadlines** — never invented: resolved deterministically from the message/meeting date in the
organisation's time zone (`tomorrow`, `within three days`, `by Tuesday`, explicit dates);
`next Friday`, `soon`, `before the release` stay **needs clarification** with the words kept; the
review form shows them and asks for a date. The time zone is stored with the date.

**One item per commitment:** `fingerprint = sha256(owner, significant words)`. A new finding with the
same fingerprint (or ≥ 0.6 word similarity for the same owner, last 30 days) adds *supporting*
evidence to the existing item (any source, including meetings) and flags `merged_sources`.

**Evidence trail** (`action_item_evidence`): `origin` (where it was agreed: transcript segment or
synced record with URL), `supporting` (same commitment elsewhere, the parent issue/file),
`progress` and `completion` (linked Jira/GitHub/Figma state, `services/actions/progress.js`).
The item's work status is shown as *not started / in progress / implementation complete (confirm) /
blocked / done*; WorkAgent never marks an item done by itself.

## 3. Action Center (`/actions`)

Views: all, mine, my teams, pending review, overdue, due in 7 days, blocked, unassigned, awaiting
execution, completed. Filters: project, team, owner, priority, source, category, search.
Visibility: admins all; project owners every item of their projects (incl. pending); team leads the
approved work of their team; everyone their own approved items (items without a meeting need only
approval). Review (edit, approve, reject, reopen) uses the same rules as the meeting review screen.

Lifecycle shown: *Extracted* (pending, nothing to fix), *Needs review*, *Approved*, *Scheduled*,
*Executing*, *Completed*, *Failed*, *Retry required*, *Rejected*.

## 4. Execution engine (`services/execution/`)

One engine for every write; pages and the assistant only *prepare* plans.

| Kind | Target | Idempotency | Verification | Status |
|---|---|---|---|---|
| `jira.create_issue` | Jira project (mapped to the item's project, chosen, or the only one) | label `workagent-item-<id>` looked up first | `GET issue` | tested (mocked) |
| `jira.comment` | linked Jira issue | marker in the comment | provider id | tested (mocked) |
| `jira.update` (priority, due date, assignee) | linked issue | same values twice are harmless | read back fields | tested (mocked) |
| `jira.transition` | linked issue | already in that status → done | read back status | tested (mocked) |
| `jira.link` | linked issue ↔ key | existing link checked | — | tested (mocked) |
| `email.send` (assignment, reminder, overdue/blocker escalation, meeting summary, custom) | directory users only | provider idempotency key; SMTP interruptions are not re-sent | provider message id | tested (mocked provider) |
| `teams.message` | Teams channel (needs `TEAMS_MESSAGE_SEND=true` + `ChannelMessage.Send`) | marker searched in recent messages | message id | development mock tested; real Graph **not verified** |
| `github.create_issue`, `github.comment` | repository / linked issue or PR (App needs *Issues: write*) | hidden marker searched first | `GET issue` | code only; **not verified** (no write-enabled App) |
| `calendar.schedule` | WorkAgent / Outlook / Google calendar of the approver (existing scheduling) | — | invitations sent | tested (WorkAgent calendar) |
| `workagent.notify` | owners, in-app | notification dedupe | created | tested |

Flow and guarantees:

1. **Prepare** checks that the person may act on every item (admins, the project's manager) and
   that items are approved, builds the exact content (description with the WorkAgent action id and
   evidence quotes; e-mail subject and body; Teams HTML), lists recipients and affected people,
   skips what is already done or planned (unique idempotency key), and stores the plan.
2. **Approve** requires the preview hash the person saw (`PREVIEW_CHANGED` otherwise), an explicit
   second confirmation above `ACTION_LARGE_THRESHOLD`, and re-checks provider permissions **with the
   approver's own rights** (e.g. the linked Jira account must hold `CREATE_ISSUES`/`ASSIGN_ISSUES`).
3. **Cancel window** (`ACTION_CANCEL_SECONDS`, default 60): nothing is written; *Cancel* stops it.
4. **Execute** (job `action.execute`, restart-safe): conditional claim per execution; transient
   errors retried with exponential backoff; the rest end as *failed* / *retry required* with the
   error, stay visible, notify the requester/approver, and can be retried manually.
5. **Succeeded** only when the provider returned the object; **verified** when it was read back.
   An attempted request is never reported as done.
6. **Write-back:** created Jira issues are ingested and linked to the item (`tracks`, confirmed);
   e-mails are stored in `email_messages` (linked to the execution and, via
   `email_message_items`, to every item); all transitions are in `audit_logs`.
7. Automated follow-up e-mails (only when an admin enabled them) are plans approved by that policy
   (`approval_basis = 'policy'`), visible on the Approvals page.

Approvals (`/approvals`): plans awaiting approval, in progress, failed, completed — with the approved
preview, every execution's external reference and error, retry, and the audit trail.

## 5. Assistant

Available on every page (dock) and at `/assistant`. Closed intent set:
`create_meeting`, `assign_task`, `update_task`, `set_deadline`, `query_status` (existing) and
**`query_work`** and **`act_on_actions`** (new, `services/assistant/work.js`).

- `query_work` (read-only, counted in code): action items (e.g. "from yesterday's meetings"),
  overdue commitments, who/what blocks a project (with the blocker's evidence), promised vs.
  actual progress (linked Jira/GitHub/Figma state), owners with pending items, Figma changes since
  a meeting.
- `act_on_actions`: create Jira issues, e-mail owners, notify owners, post to Teams, send a meeting
  summary, send the weekly report — always as an execution-engine plan shown in full (recipients,
  content), confirmed by the person; the cancel window is the command's undo.
- Enum slots need their words in the request and text slots must be grounded, otherwise the
  assistant asks instead of guessing; ambiguous projects/meetings/people become choices.
- Every command is stored in `command_invocations` and audited; plans carry `command_id`.

## 6. Follow-up automation (`services/actions/followups.js`, hourly)

Reminders before the due date (owner), overdue escalation (project owner, else team lead),
commitments without progress (owner), blockers unresolved for N days (manager). Once per item, rule
and day. In-app by default (each person's preferences apply); e-mail only if an admin turns it on
(`/actions/settings`). Weekly digest: unchanged (Friday 17:00 org time, numbers in code), see FEATURES.md §5.

## 7. Data model (migration 018, additive; rollback `docs/runbooks/rollback-018.sql`)

| Table / column | Purpose |
|---|---|
| `action_items.meeting_id` → nullable; `source_type`, `source_record_id`, `category`, `team_id`, `department_id`, `assignee_kind`, `assignee_team_id`, `deadline_status`, `due_timezone`, `created_by`, `fingerprint`, `execution_status` | items from every source |
| `action_item_evidence.record_id`, `source_url`, `occurred_at`, `relation` | evidence from synced records |
| `action_source_scans` | which records were analysed (content hash, outcome) |
| `action_plans`, `action_executions` | execution engine (preview, approval, idempotency key, attempts, external refs, verification) |
| `email_messages.meeting_id` → nullable; `action_execution_id`, `kind` | e-mail history for executions |
| `meeting_bot_sessions`, `vexa_webhook_events` | automatic Vexa transcription |
| google_meet → google_calendar | provider rename across connection/record tables; `meeting_schedules.provider` enum |

Migration 019 adds the two assistant intents to `command_invocations.intent`.

## 8. API (all under `/api/v1`, signed in)

| Area | Endpoints |
|---|---|
| Action Center | `GET /actions?view=&projectId=&teamId=&ownerId=&priority=&source=&category=&q=`, `GET /actions/summary`, `GET /actions/:id`, `PATCH /actions/:id`, `POST /actions/:id/{approve,reject,reopen,status}` |
| Execution | `GET /actions/execution/capabilities`, `POST /actions/execution/plans`, `GET /actions/execution/plans[/:id]`, `POST /actions/execution/plans/:id/{approve,cancel,reject}`, `POST /actions/execution/executions/:id/retry` |
| Settings (admin) | `GET /actions/settings`, `PUT /actions/settings/{followups,sources}`, `POST /actions/settings/sources/scan` |
| Vexa (admin) | `GET /integrations/vexa`, `POST /integrations/vexa/{connect,disconnect,sync}`, `PUT /integrations/vexa/settings`, `GET /integrations/vexa/sessions`, `POST /integrations/vexa/sessions/:id/{retry,skip}`; public `POST /webhooks/vexa` (signed) |

## 9. Tests

| Suite | Covers |
|---|---|
| `test/vexaAuto.test.js` (15) | connection + consent, webhook registration, discovery, eligibility/policy, one bot per meeting across calendars and workers, lifecycle, delayed transcript, host refusal, busy-Vexa retries, missed meetings, cancellation/reschedule, restart recovery, signed and de-duplicated webhooks |
| `test/actionIntelligence.test.js` (15) | categories, deadlines, team owners, fingerprints, pre-filter; Teams/Jira/GitHub extraction, invented owners/quotes refused, ambiguous names, re-analysis merge, cross-source merge with a meeting item, completion evidence, Action Center views/visibility/review |
| `test/execution.test.js` (12) | Jira create/comment/update/transition/link with read-back, preview hash, approver permissions, cancel window, retries, permanent failures + manual retry, duplicate prevention, e-mail drafting/recipients/delivery/linking, changed address, meeting summary, Teams mock, calendar scheduling + verification, bulk confirmation, visibility |
| `test/followups.test.js` (3) | reminders, escalations, no progress, blockers, once per day, preferences, policy e-mail plans |
| `test/assistantWork.test.js` (7) | grounded intents/slots, yesterday's meetings, overdue, project blockers with a choice, promised vs. progress, bulk e-mail plan + confirm + undo (cancel), blocked operation, ambiguous selection |
| `frontend/src/pages/actions/Actions.test.jsx` (10) | Action Center views/filters, execute panel preview → approve → cancel, detail evidence/retry/review, Approvals, Vexa card, assistant dock |

Live checks on 2026-11-15: Gemini source analysis of the Teams development-mock data (dev and test
databases: 15 + 18 threads, 27 items, owners/deadlines as expected, e.g. "before we merge" left
unresolved); Vexa `GET /auth/me` against the local self-hosted gateway; browser walk-through of the
Action Center, review, Teams-mock execution with cancel window and verification, Approvals, Vexa
card, light/dark themes and the assistant dock. A live assistant parse was rate-limited by Gemini
at the time (the assistant answered "Nothing was changed").

## 10. Known limits and external requirements

- Jira writes need `JIRA_ISSUE_CREATION=true` (write scope), a reconnect, and each approver's Jira
  identity linked; tested against a fake Jira only.
- GitHub writes need the App's **Issues: Read and write** permission; not verified.
- Teams messages need `TEAMS_MESSAGE_SEND=true` and `ChannelMessage.Send` consent on a real tenant;
  only the development mock is tested. Personal chats/@mentions are not used.
- E-mail goes through the existing provider (SMTP/Resend); "sent" means accepted by the provider.
- Vexa: automatic dispatch into a real Google Meet call is not verified; Google Meet only.
- Source analysis is per thread and capped per run (`maxThreadsPerRun`, default 15); large backlogs
  take several runs and use WorkAPI quota (Gemini rate limits were hit during the live check).
- Duplicate detection, KPIs, groups and the weekly digest are otherwise unchanged (FEATURES.md).
  Approved items from every source appear in the digest (commitments at risk), Insights, duplicate
  detection and My tasks; the KPI *meeting-to-action conversion* deliberately counts meeting items only.
