# Microsoft Teams — development mock

Microsoft Teams can be shown **CONNECTED** in WorkAgent without a Microsoft 365 tenant, for development and demonstrations, as a clearly labelled **DEVELOPMENT MOCK**. It is not a Microsoft connection: nothing is sent to or received from Microsoft, and the account is never presented as verified.

## What the mock is

- `TEAMS_INTEGRATION_MODE=mock` replaces the Teams connector with a mock connector (`backend/src/services/integrations/providers/microsoft/teamsMock.js`) that has the same contract. Everything after it is WorkAgent's normal code: connections, resources, the sync engine, ingest into the work graph (records, activities, identities matched by e-mail), the transcript importer (WorkAgent meetings and transcripts), WorkAPI extraction and review.
- Data: the fictional company **Violin Technologies** (`backend/src/services/integrations/mock/violinFixture.js`): 24 employees (employee id, name, `@violin.example.com` address, department, job title, manager, team membership), 7 departments (Engineering, Product, Design, QA, Human Resources, Finance, Marketing), 7 teams (Payments Team, Platform Engineering, Frontend Engineering, Backend Engineering, Design Team, QA Team, Product Management) with 18 channels, 19 channel posts with 26 replies and reactions (technical discussions, updates, blockers, design feedback, decisions, assignments, release updates), 4 projects, and 10 meetings (standup, payments architecture review, sprint planning, roadmap, design review, QA release readiness, management meeting, backend API review, frontend integration review, retrospective) with multi-speaker transcripts containing assignments, deadlines, blockers, commitments and decisions.
- Times are relative to an anchor (the day before the first seed), so all meetings are in the past and re-seeding produces the same records.

## How mock records are identified

| Data | Marker |
|---|---|
| Connection | provider `microsoft_teams`, source `microsoft.mock-violin-technologies`, display name "Microsoft Teams · Development mock (Violin Technologies)", `settings.mode = 'mock'`, `settings.verified = false` |
| Channel messages, replies, meetings (external records) | source `microsoft.mock-violin-technologies`, `metadata.isMock = true` |
| People in Teams (external identities) | source `microsoft.mock-violin-technologies` |
| Employees, departments, WorkAgent teams, projects, imported meetings | a row in `mock_records` (migration 017) with source `teams_mock` and a stable key such as `employee:VT-003`; people use `@violin.example.com` addresses and have no password (they cannot sign in) |

Names that already exist as real data (e.g. a real "Engineering" department) are never reused: the mock creates "Engineering (Violin Technologies)" instead. An existing real account with a mock e-mail address is skipped and reported.

## Seed (and re-seed)

```
cd backend
# backend/.env: TEAMS_INTEGRATION_MODE=mock   (never in production: the server refuses to start)
npm run migrate            # adds mock_records (017)
npm run teams:mock:seed    # idempotent: run as often as you like
```

Or in the app: **Integrations → Microsoft Teams → Sync Mock Data** (admins). The card then shows:

Status CONNECTED · Mode DEVELOPMENT MOCK · Account demo.user@example.com · Organisation Violin Technologies · Teams 7 · Channels 18 · Meetings 10 · Messages 45 · last sync time — with **View Teams**, **Sync Mock Data**, **Reset Mock Data**, **Disconnect**.

You can also connect it like any integration (**Connect Microsoft Teams (development mock)**): the normal single-use state is used, but there is no Microsoft sign-in.

Importing the transcripts queues WorkAPI extraction for the 10 meetings (when `TRANSCRIPT_AUTO_EXTRACT=true` and WorkAPI is configured); the worker runs them and the items appear in review like any meeting. Note: on the Gemini free tier this uses 10 of the daily requests.

## Reset

**Reset Mock Data** (or `npm run teams:mock:reset`) deletes only what the mock created: its connection, resources, records, activities, links, identities, the imported meetings (with their transcripts and action items), and the registered employees, departments, teams and projects. Nothing else. A mock employee that real data still references (e.g. you added them to a real project) is deactivated instead of deleted and reported.

**Disconnect** marks the mock connection disconnected and keeps its data (like any integration); **Sync Mock Data** reconnects it.

## Mock versus real Microsoft OAuth

| | Development mock | Real Teams |
|---|---|---|
| Sign-in | none | Microsoft Entra OAuth (delegated) |
| Data | fictional fixture | your tenant's teams, channels, meetings, transcripts |
| Credentials | none stored | encrypted tokens |
| Requirements | `TEAMS_INTEGRATION_MODE=mock`, not production | an Entra app with admin consent (runbook §12) |
| Label | "Development mock" everywhere | your account |

## Switching to real Microsoft Teams later

1. **Reset Mock Data** (recommended, so demo data does not mix with real data).
2. Set `TEAMS_INTEGRATION_MODE=real` and the Microsoft variables (`MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `CREDENTIALS_ENCRYPTION_KEY`) — runbook §12, including admin consent for the channel and meeting permissions.
3. Restart the API and worker, then **Connect Microsoft Teams**.

`TEAMS_INTEGRATION_MODE=disabled` hides Teams entirely (the card says it is disabled).
