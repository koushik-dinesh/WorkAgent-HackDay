# Vexa meeting transcription — setup and operation

Vexa transcribes Google Meet meetings. It replaced the former standalone Google Meet integration
(2026-11-15, migration 018): nobody connects or authorises Google Meet separately any more.

**Verification status (2026-11-15):** connection (`GET /auth/me`) verified against the local
self-hosted Vexa v0.12 gateway (`http://localhost:18056`). Discovery, dispatch, lifecycle,
transcript import, retries, cancellation, restart recovery and signed webhooks are tested against a
fake Vexa (`backend/test/vexaAuto.test.js`, `backend/test/vexa.test.js`). A bot joining a **real**
Google Meet call through the automatic flow has **not** been verified (needs a calendar connection
with a real Meet event and a host to admit the bot).

## 1. How it works

```
connect once (Integrations → Vexa): verify API key (GET /auth/me), record consent, optional webhook
        │
every minute: worker job vexa.auto_scan
        ▼
synced calendar events (Google Calendar, Outlook) with a meet.google.com link
        ▼
meeting_bot_sessions row per occurrence  ── UNIQUE(platform, link, start): one bot per meeting
        ▼
eligibility & policy (stored on the row, shown on the card)
   consent confirmed · not cancelled · not declined · timed (not all-day) · ≤ max length
   · no opt-out keyword · organiser is a WorkAgent member (or: a member attends)
   · optional: no outside attendees · not over
        ▼  shortly before the start (joinLeadMinutes, default 2)
WorkAgent meeting (participants = members) + existing meetingBot.requestBot (POST /bots)
        ▼
existing vexa.poll job follows the bot  (webhook only wakes it sooner)
joining → recording → processing → completed | failed
        ▼
transcript import (idempotent) → AI extraction (WorkAPI) → action items for review
→ Action Center → approval → execution engine (Jira, e-mail, Teams, calendar)
```

Duplicate bots are prevented three times: the occurrence's unique key (also when the same meeting
appears in several people's calendars), a conditional claim (`scheduled → dispatching`) so only
one worker sends, and the bot flow's own one-bot-per-link check. Everything is in MySQL, so a worker
restart loses nothing; a scan also recreates a missing poll job for a meeting whose bot is live.

## 2. Server configuration (`backend/.env`)

| Variable | Purpose |
|---|---|
| `VEXA_BASE_URL`, `VEXA_API_KEY` | The Vexa gateway and an API key with the `bot` and `tx` scopes |
| `VEXA_BOT_NAME` | Name shown in the meeting (default "Meeting to Action") |
| `VEXA_POLL_INTERVAL_MS`, `VEXA_POLL_TIMEOUT_MS`, `VEXA_TRANSCRIPT_WAIT_MS` | Polling (existing) |
| `VEXA_AUTO_EXTRACT` | Queue AI extraction when a transcript arrives (default true) |
| `VEXA_WEBHOOK_SECRET`, `VEXA_WEBHOOK_PUBLIC_URL` | Optional. With both set, *Connect* registers `PUT /user/webhook` → `<public URL>/api/v1/webhooks/vexa`. Deliveries are verified (`X-Webhook-Signature: sha256=HMAC(secret, "<X-Webhook-Timestamp>.<body>")`, 5-minute skew) and de-duplicated on `event_id` (Vexa delivers at least once) |
| `VEXA_AUTO_LOOKAHEAD_HOURS` | How far ahead calendar events are considered (default 24) |
| `VEXA_AUTO_MAX_DISPATCH_ATTEMPTS` | Retries when Vexa is busy/unavailable (default 5; backoff 1, 2, 4, 8, 15 min, never past the meeting's end) |

A calendar connection is needed for discovery: Google Calendar (runbook §13) or Outlook (§12).

## 3. Connecting (once)

Integrations → **Vexa meeting transcription** → write how participants are informed and consent
(stored with who confirmed it and when; required) → **Connect Vexa and turn on automatic
transcription**. The card then shows the Vexa account, bot capacity, status-update mode, discovery
sources, counts (transcribed, upcoming, in progress, failed, not recorded), the last transcript, and
every recent meeting with its state and reason.

**Transcription settings:** which meetings (organised by a member, or organised/attended by a
member), opt-out keywords (default `#norecord`, `#no-transcript`, `[no bot]`), how early the bot is
sent, the longest meeting to record, and internal-only. **Pause** stops new dispatches;
**Disconnect** also cancels every scheduled occurrence (bots already in a meeting finish).

## 4. Consent, host permissions and limits

- Nothing is recorded without the organisation's consent statement.
- The bot is a **visible participant** and must be **admitted by the host** from the Meet lobby. A
  host who declines or does not admit it ends the session as *failed* with the reason
  ("The host declined to admit the bot", "Nobody admitted the bot from the lobby in time"); it is
  not retried automatically.
- Not every meeting can be recorded: declined, all-day, opted-out, too long, external-organiser (by
  default) and — if configured — meetings with outside attendees are *not recorded*, with the reason.
- When a meeting will have no automatic transcript (bot failed, missed, refused), the organiser and
  admins get a *transcription unavailable* notification; a transcript can still be uploaded by hand.
- Google Meet only (Teams/Zoom links are not dispatched).

## 5. Operations

| Situation | What happens / what to do |
|---|---|
| Vexa busy (concurrency limit) or unavailable | Session stays *scheduled* with "Will retry"; retried with backoff; *failed* after the last attempt. **Retry** on the card |
| Meeting cancelled before the bot was sent | Session *cancelled* on the next scan |
| Meeting cancelled after the bot was sent (before the start) | The bot is stopped (`DELETE /bots/…`), session *cancelled* |
| Meeting rescheduled before dispatch | Session follows the new start time |
| Meeting ended before a bot could be sent (worker down) | *failed*: "The meeting ended before the bot could be sent" |
| Transcript late | The poller keeps checking for `VEXA_TRANSCRIPT_WAIT_MS`; session shows *Waiting for transcript* |
| Transcript never arrived | **Retry** on a failed session after the meeting looks for it again |
| Worker restarted | Sessions, meetings and poll jobs are rows; the next scan recreates any missing poll job |

## 6. Live verification checklist

1. Connect Vexa on the card; the account e-mail and capacity appear (done locally 2026-11-15).
2. Connect Google Calendar (or Outlook) and enable the calendar.
3. Create a Google Meet event starting in ~5 minutes, organised by a WorkAgent member.
4. *Check calendars now*: the meeting appears as *Scheduled*; ~2 minutes before the start it moves
   to *Joining*. Admit the bot; it shows *Recording*.
5. End the meeting: *Waiting for transcript*, then *Transcribed*; the meeting page shows the
   transcript and pending action items.
6. Repeat with `#norecord` in the description: *Not recorded* with the reason.
