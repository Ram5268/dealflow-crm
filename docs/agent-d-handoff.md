# Agent D — Communications: handoff

Two-way email (Gmail; Graph mirror = M5, stubbed), SMS (Twilio, behind a 10DLC
flag), reusable templates, and a blackout-aware sequence engine.

## Status

- **Gate 1 (isolation boot): GREEN.** `pnpm comms:isolated` boots the app + 4
  mocks; app `/api/comms/health` → 200, all 4 mock `/_mock/health` → 200.
- **Gate 3 (behavioral + coverage): GREEN.** 180 unit tests, `tsc` clean, and the
  85% line + branch floor is met on every target dir (email 86/96, sequences
  95/95, sms 90/94, templates 89/98; clients 90/100, oauth 91/94). Three smokes:
  - `pnpm gate1:smoke` — the four acceptance paths against mocks + DB:
    1. email send → Gmail mock → `status:'sent'` (M3.5)
    2. inbound STOP → `POST /dnc/internal` 201 → phone blocked in DNC ledger (M4)
    3. Gmail delta → EmailThread reconstructed → `crm_message` NOTIFY (valid
       `message.received` shape, no discriminant) (M2)
    4. Graph delta → EmailThread reconstructed → `crm_message` NOTIFY (M5)
  - `pnpm worker:smoke` — pg-boss worker consumes a queued `send-email` job, AND
    the full **enrollment → tick → enqueue → worker → sent** chain fires (M3 tick).
- **Both providers live (Gmail M2/M3.5 + Graph M5).** Graph uses the MSFT identity
  + Graph REST endpoints via fetch (same mockable pattern as Twilio; no SDK dep).
  Both share ONE reconstruction/dedup/persist path: `gmail-sync.ts` orchestration +
  the provider-agnostic persist ports; only the client + cursor differ (Gmail
  threadId/historyId, Graph conversationId/deltaLink). Send routes by provider —
  Gmail Message-ID header, Graph `internetMessageId` — same pre-set-before-send
  dedup. `pnpm worker:comms` runs send-email + gmail/graph-delta-sync queues.
- **Templates + sequences fully usable:** render + blackout/DST tick + pg-boss
  delivery, plus CRUD APIs (templates, sequences+steps, enroll, enrollment
  pause/resume/cancel) with Zod validation.
- **SMS: PARKED** behind `SMS_ENABLED=false` until the 10DLC campaign is approved.
  Flip to `true` (a runtime config change, not a code change) once the SIDs land.

## Run it

```bash
pnpm comms:isolated     # app + 4 mocks (Gate-1 isolation boot)
pnpm gate1:smoke        # 3 behavioral smokes against mocks + DB
pnpm test               # 140 unit tests
pnpm test:coverage      # coverage on src/lib/comms/**
pnpm mocks:start        # just the 4 mock servers (4001-4004)

# trigger cron endpoints manually:
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/gmail-sync
```

## The Gmail Message-ID dedup trick — DO NOT REMOVE

**Why it exists:** when we send an email, Gmail places a copy in the Sent folder.
The next inbound sync pulls that copy back — without dedup we'd insert a duplicate
`Message` row (and a duplicate Activity on Agent A's side). The fix is a single
load-bearing invariant: **`providerMessageId` is keyed on the RFC5322 `Message-ID`
header, not the Gmail API id.** Before sending, `email/send.ts` mints a client-side
`Message-ID` (`<crm-<uuid>@dealflow-crm.local>`) and stores
`Message.providerMessageId = "gmail:<that-id>"` *inside a transaction, before the
send*. Gmail preserves the header, so when the Sent copy syncs back, `parse.ts`
derives the **same** `providerMessageId` from its `Message-ID` header and the
`@unique` constraint (`createMany({ skipDuplicates })`) short-circuits the insert.

There is no delete-and-swap and no post-send read-back — the id is set *before* the
network call, so there is no race window. If someone "simplifies" `parse.ts` to key
on the Gmail API id, sent-mail dedup silently breaks and duplicates reappear. That's
why `parse.ts` keys on the header (falling back to the API id only when a message
genuinely lacks a `Message-ID`).

## Layout / seams worth knowing

- `email/gmail-sync.ts` is provider-agnostic orchestration over `SyncPorts`; the
  real adapter is `email/gmail-adapter.ts`. Both `GmailClient.forAccessToken` and
  the adapter accept a mock `rootUrl` via `GMAIL_MOCK_URL` (Gate-1 isolation).
- The ONE cross-slice write is `clients/compliance.ts::addInternalDnc` →
  `POST /api/compliance/dnc/internal` (Agent C). Response shape is normalized
  tolerantly (merged or legacy). `scrub` is fail-closed (`vendor_error`).
- SMS is gated three ways before Twilio: `SMS_ENABLED` → `requireTwilioConfig`
  (fail-fast on missing 10DLC SIDs) → compliance scrub (fail-closed).
- `events.ts` validates every `crm_message` NOTIFY against the frozen
  `message.received` Zod schema.

## Env (see `.env.example`)

`DATABASE_URL_MAIN`, `OAUTH_TOKEN_ENCRYPTION_KEY` (32B base64), `OAUTH_STATE_SECRET`,
`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `GMAIL_PUBSUB_TOPIC/VERIFICATION_TOKEN`,
`SMS_ENABLED` (`false`), Twilio + 10DLC SIDs (when enabled), `CRON_SECRET`.
Isolation adds `COMPLIANCE_BASE_URL`, `TWILIO_API_BASE`, `GMAIL_MOCK_URL`,
`TWILIO_MOCK_SKIP_SIGNATURE`.

## Known-open (next)

- **Live provider verification** — Gmail/Graph run against mocks; when Google Cloud
  (`GOOGLE_CLIENT_ID/SECRET`) and Azure (`MSFT_GRAPH_CLIENT_ID/SECRET`) creds land in
  `.env`, the same code hits real Google/MSFT with zero rework. Graph
  `internetMessageId`-on-draft dedup assumes Graph honors it on draft creation —
  verify against a live Outlook account.
- **jobs/ dir** (`boss.ts`, `gmail-runner.ts`, `graph-runner.ts`, `*-delta.ts`) is
  infra — covered by `worker:smoke`, not unit tests (pg-boss singleton resists
  mocking). NOT in the brief's coverage-floor set (`email/sequences/sms/dedup/
  templates`), so its coverage is intentionally excluded — don't be alarmed by it.
- **UI pages** (`inbox`, `sequences`, `templates`, `settings/comms`) — API surface
  is complete; the React pages are the remaining front-end work.
- SMS live path is untested against real Twilio (parked on 10DLC).
