# Integration Setup — Gmail, Google Calendar, Google Meet

Status: **architecture and API surface built; every Google network call is
blocked on credentials AMM Brands must supply** (blueprint Phase 9).

What exists and runs today, verified by tests:

- `google_accounts` table (OAuth tokens **encrypted at rest**, AES-256-GCM),
  `emails` and `meetings` with an `is_sandbox` flag.
- `GET/POST /api/integrations/google/{status,auth-url,callback,sync,emails}`
  and `DELETE .../connection`.
- A three-state mode switch (`GOOGLE_INTEGRATION_MODE`), and the sender ->
  client/vendor/lead linking logic, which runs identically in sandbox and live
  mode and is therefore genuinely exercised.

What does **not** exist: any executed call to a Google API. `LiveGmailProvider`
throws a clear error rather than shipping code that has never run against a
real Workspace account. Nothing in this repo has ever completed an OAuth flow.

## The three modes

| `GOOGLE_INTEGRATION_MODE` | Behaviour |
| --- | --- |
| `disabled` (default) | Every Google endpoint returns **503** with the setup steps. Deliberately not an empty inbox, which would read as "no mail today". |
| `sandbox` | Two obviously-synthetic messages from `@example.invalid`, stored with `is_sandbox = true`. No network call, no OAuth, and sending always refuses. |
| `live` | Requires all three credentials below. If any is missing the app logs an error and **falls back to `disabled`** rather than failing later at the first API call. |

There is no code path that writes a `google_accounts` row without a real token
exchange having succeeded, and none that marks the integration connected in
sandbox mode. A test asserts both.

## What we'll need from AMM Brands

1. **A Google Cloud project** (new or existing) with billing enabled (Google
   APIs used here are free at AMM's expected volume, but a project needs
   billing enabled to raise API quotas beyond the sandbox default).
2. **OAuth consent screen** configured as **Internal** if AMM Brands uses
   Google Workspace (recommended — restricts the app to `@ammbrands.in`
   accounts, no Google verification review needed) or **External** with the
   app in "Testing" mode for a pilot with a handful of named test users.
3. **OAuth 2.0 Client ID** (Web application type), with:
   - Authorized redirect URI: `https://<your-domain>/mail/connect`
     (or `http://localhost:3000/mail/connect` for local dev — the web page
     that hands the one-time code to `POST /api/integrations/google/callback`).
4. **APIs enabled** on that project: Gmail API, Google Calendar API. (Google
   Meet links are created as a side effect of a Calendar API event insert
   with `conferenceData` requested — there is no separate "Meet API" to
   enable for that use case.)
5. The resulting **Client ID** and **Client Secret** go into `.env` as
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (already present
   as placeholders in `.env.example`) — never commit real values.

## Scopes — deliberately minimal (blueprint §16/§24)

```
openid
email
profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar.events
```

**Never request `gmail.modify`, `gmail.metadata`-only-then-widen, or full
mailbox scope.** `gmail.readonly` + `gmail.send` covers everything the
prototype's Mail screen does (read, reply, no delete/label-management via
API). `calendar.events` (not full `calendar`) is enough to create/read
events this app creates — it cannot read or modify the user's entire
calendar.

## What gets built against these, when this phase is picked up

### Gmail sync (`emails` table)
- OAuth2 code exchange → store refresh token encrypted, associated with the
  `User` who connected it (per-user connection, not a shared mailbox).
- Initial sync: `users.messages.list` for the last N days, or a fixed count,
  to seed the inbox view — **not** a full mailbox mirror (data minimization).
- Incremental sync: Gmail `history.list` keyed off a stored `historyId`,
  ideally driven by a `users.watch()` Pub/Sub push subscription rather than
  polling (polling is the fallback if Pub/Sub setup is deferred).
- Store only: `gmail_message_id`, `thread_id`, from-address, subject, a body
  snippet, received timestamp, read/starred flags. Full body fetched on
  demand when a user opens a message, not stored redundantly.
- Linking: match sender domain/email against `clients`, `vendors`, `leads`
  (via their contact email fields once `client_contacts`/`vendor_contacts`
  are populated with real email addresses) — unmatched mail routes to a
  "needs linking" view, mirroring the prototype's `link: null` case.
- Disconnect/token-expiry handling: surface as a visible banner in Settings
  (per the original prompt's §14 "integration health surfaced in the app
  itself"), never a silent failure.

### Calendar / Meet (`meetings` table)
- Creating a `meetings` row (from the app) → `events.insert` on the
  connected user's calendar with `conferenceDataVersion: 1` and a
  `createRequest` to get a real Meet link back — store that link in
  `meetings.meet_link`.
- Post-meeting notes/action items: Google Meet doesn't expose transcripts or
  notes via a general API without Workspace add-on entitlements AMM may not
  have; treat "notes → tasks" (automation `au9`) as a manually-entered notes
  field for V1, promotable to tasks by a human, not an automated transcript
  pull, unless AMM confirms they have Gemini/Meet transcription entitlements
  worth building against.

## Remaining work — exactly what is blocked on you

Everything below needs credentials for AMM Brands' real Google Workspace. Each
item is a documented request shape in `apps/api/src/google/gmail.provider.ts`,
not written blind and not tested, because it cannot be tested without an
account to test against.

1. **`LiveGmailProvider.fetchSince`** — full sync
   (`users/me/messages?q=newer_than:30d` + batched metadata GETs) and
   incremental sync (`users/me/history?startHistoryId=...`), including the
   404-on-expired-history fallback to a full sync.
2. **`LiveGmailProvider.send`** — `users/me/messages/send` with a base64url
   RFC 2822 body, under `gmail.send`.
3. **`users.watch()` + Pub/Sub push** so sync is event-driven rather than
   polled. Needs a Pub/Sub topic in the same Google Cloud project.
4. **Calendar / Meet** — `events.insert` with `conferenceDataVersion: 1` to get
   a real Meet link into `meetings.meet_link`.

### What I need from you to unblock these

| Needed | Where it goes |
| --- | --- |
| OAuth Client ID | `GOOGLE_OAUTH_CLIENT_ID` |
| OAuth Client Secret | `GOOGLE_OAUTH_CLIENT_SECRET` |
| Authorized redirect URI registered in Google Cloud | `GOOGLE_OAUTH_REDIRECT_URI` |
| A 32-byte secret for token encryption (production) | `GOOGLE_TOKEN_KEY` |
| Confirmation that Gmail API + Calendar API are enabled on the project | — |

Then set `GOOGLE_INTEGRATION_MODE=live`. Until all four are present the app
will refuse to run in live mode, by design.

### A note on Meet notes -> tasks (automation au9)

Google Meet exposes no transcript or notes API without Workspace add-on
entitlements AMM may not hold. `meetings.notes` is therefore a
manually-entered field that a human promotes to tasks, not an automated
transcript pull — unless you confirm AMM has Gemini/Meet transcription
entitlements worth building against.
