# Agent D Executor Brief — Communications (Email + SMS + Sequences + 10DLC)

## Front matter

You are building the **Communications slice** of `dealflow-crm`, a new greenfield CRM that replaces Mojo Dialer + Mojo CRM for a solo NYC real-estate broker. Your slice owns two-way email sync (Gmail + Microsoft Graph), two-way SMS (Twilio Programmable Messaging under 10DLC), reusable message templates, and a time-based sequence engine with blackout dates. You will build this in isolation over ~1-3 weeks, with all other agents' code absent and their contracts mocked; your slice must pass three gates (runs in isolation, honors contracts, does its job) before integration.

## BLOCKING ISSUES — READ FIRST

### Blocking issue A — 10DLC (external calendar time)

**10DLC registration is external calendar time (1-4 weeks) and MUST be filed on Day 1 before anything else.** Unregistered A2P SMS in the US has been fully blocked since Feb 2025 — messages will silently fail without registration. You cannot ship SMS without it, and you cannot start it until the Twilio Trust Hub Brand + Campaign registrations return SIDs. This is calendar time, not work time. See Milestone 1 for exact steps. While you wait, you build email + sequences (email-only) + Graph sync.

### Blocking issue B — Planner-owned contract questions

Before Milestones 2.1, 3.5, or 4 can be executed, the planner MUST resolve the following contract questions and update `dealflow-crm/CONTRACTS.md`. These are open contract items, not executor freedom. If any is unresolved when you reach the milestone that depends on it, STOP and route to the planner. Do not silently patch.

1. **`POST /api/compliance/dnc/internal` — RESOLVED.** Per the cross-brief consistency review, Agent C's brief §2 confirms this endpoint exists as an exposed C endpoint. D proceeds with the HTTP path. The `sms.stop-received` event-based fallback is **NOT** implemented. Do not emit `sms.stop-received`, do not add it to `contracts/events/`, and do not add a `LISTEN crm_scrub` consumer. If planner later reverses this, they will explicitly re-open the question — otherwise the HTTP path is authoritative.

   However, the **response shape** for this endpoint is contested. C's brief §7.4 responds `{ id, phone, source: "internal", addedAt }`. This brief's §9 expects `{ dncId: string, added: boolean }`. Planner must lock one shape; the working assumption in this brief (per critique recommendation) is the merged shape: `{ id, phone, source: "internal", addedAt, added: boolean }`. The `added: boolean` distinguishes idempotent-already-existed from newly inserted — useful telemetry. Client wrapper in `clients/compliance.ts` MUST tolerate either legacy shape by mapping `id → dncId` and defaulting `added=true` when the field is absent, so the slice does not break if C ships a subset first. Contract tests assert against the merged shape.

2. **`OAuthCredential` model — schema addition.** SHARED_CONTEXT §3 says the schema is FROZEN. Adding a new table is a schema change per §12. This brief needs `OAuthCredential` (Agent-D-owned; per-tenant Gmail/Graph refresh tokens, encrypted). Before your Milestone 2.1 begins, the planner must bless the addition and fold it into the shared schema (preferred), so the migration you run is the additive `comms-oauth-credentials` migration on top of the already-frozen shared schema. Do NOT silently add the model in your migration until planner has confirmed.

3. **`Message.status` enum — Twilio delivery states.** Schema enum is `inbox|draft|scheduled|outbox|sent|error`. Twilio delivery-status webhooks emit `queued|sent|delivered|undelivered|failed`. Milestone 4 tests require you to update Message.status from delivery callbacks, which the current enum cannot honor cleanly. The planner must pick ONE of two resolutions before M4 starts: (a) extend the enum to `inbox|draft|scheduled|outbox|sent|delivered|undelivered|failed|error`, or (b) keep `status` coarse (`outbox|sent|error`) and add a new column `Message.providerDeliveryState String?` that stores raw Twilio state, updated from status callbacks — Message.status stays `sent` on Twilio 'sent' and moves to `error` on `undelivered|failed`. Default this brief assumes resolution (b) until told otherwise, per the cross-brief critique recommendation, because (b) doesn't reshape the frozen enum other slices might read; on resolution (a) you widen the enum instead.

### Blocking issue C — Cross-slice contract drifts (planner-owned, not executor freedom)

The cross-brief consistency review surfaced additional wire-level drift across the four briefs. These affect Agent D's contract tests and mock shapes. Do NOT silently patch — flag if unresolved.

1. **Event-payload discriminant convention.** Some briefs' emitters include an `eventName`/`type` field in payloads; D's `message.received` emits WITHOUT one, per SHARED_CONTEXT §5. Recommended lock: no discriminant in payload; channel name is the routing signal. D emits without `eventName` unconditionally. Consumers of D's events (Agent A activity projector) must not rely on a discriminant field being present.

2. **`crm_lead_sync` consumer table update.** SHARED_CONTEXT §5 lists only A as consumer of `lead.upserted-from-import`. D adds itself as a consumer (§8 below, for thread reconcile). This is additive and benign but the shared catalog should list D. Planner action: update SHARED_CONTEXT §5 to add D as a documented consumer.

3. **`sms.stop-received` — not needed.** Per B.1 resolution, this event is NOT emitted. If a contract Zod schema was scaffolded for it, delete it. Do not populate `contracts/events/sms-stop-received.ts`.

## 1. Project context

**Ryan Martin** is a solo NYC Douglas Elliman real-estate broker, non-engineer, single-operator, one seat. He is currently paying for Mojo Dialer + Mojo CRM and wants to replace them entirely with `dealflow-crm`.

**DealFlow** (`dealflow-inbox-intelligence`) is the EXISTING sibling app. It reads Ryan's Outlook inbox READ-ONLY via Microsoft Graph, classifies real-estate emails, extracts BUYER_ISO / listing opportunities, runs a matcher that pairs sellers with buyers, and runs a nightly ranker that emits a ranked call list (CallQueueEntry). DealFlow stays running. `dealflow-crm` reads DealFlow's derived signals via a read-only Postgres role and layers the phone dialer, contact database, sequences, and messaging on top.

**Greenfield decision (settled — do not re-litigate):** Twenty/Atomic CRM/ICTCRM were all evaluated and rejected. `dealflow-crm` is a fresh Next.js 16 + Prisma 7 + Postgres 16 build, sibling repo to DealFlow (not a subdir, not a monorepo).

**Stack (frozen, exact pins):** Next.js 16.2.5, React 19.2.4, TypeScript 5.6+, Prisma 7.8+, PostgreSQL 16 on Railway, Tailwind 4, shadcn/ui, react-hook-form + zod, Vitest, pnpm 9, Node 22 LTS, pino, Sentry, Doppler for secrets, pg-boss for background queues, Twilio Programmable Voice, Twilio Programmable Messaging, Gmail API, Microsoft Graph, Cloudflare R2. No Redis (pg-boss on PG), no GraphQL (REST), no Supabase.

**Four-agent parallelism:** Four executors work concurrently on four vertical slices — A (Core Data), B (Telephony), C (Compliance), D (Communications — this brief). Each slice is a package with its own tests and CI job. Each executor works in its own git worktree, sees only its brief. You are **Agent D**. You will NOT see the other briefs. Everything you need is in this document.

**Frozen contracts:** the Prisma schema (§7 below), the event catalog (§8), and the HTTP contracts (§9) are FROZEN. If you find one is wrong, STOP and message the planner (Ryan). Do not silently patch — that's how 4-agent parallelism collapses. See §14.

## 2. What this slice owns

**Prisma tables (WRITES — you are the only writer):**
- `Message`
- `EmailThread`
- `MessageTemplate`
- `Sequence`
- `SequenceStep`
- `SequenceEnrollment`
- `OAuthCredential` (Agent-D-owned; contingent on planner bless per Blocking Issue B.2)

**HTTP endpoints you expose:**
- Messages
  - `GET  /api/comms/messages` — list, filterable by contactId/leadId/channel/direction/status.
  - `POST /api/comms/messages` — send outgoing email or SMS (immediate or scheduled).
  - `GET  /api/comms/messages/:id` — single message with rendered body.
- Threads
  - `GET  /api/comms/threads?contactId=…` — list threads participating.
  - `GET  /api/comms/threads/:id` — thread + messages, ordered ascending by activityAt.
- Templates
  - `GET/POST/PATCH/DELETE /api/comms/templates` — CRUD.
- Sequences
  - `GET/POST/PATCH/DELETE /api/comms/sequences` — CRUD.
  - `GET  /api/comms/sequences/:id/steps` — steps in ordinal order.
- Enrollments
  - `POST  /api/comms/enrollments` — enroll a contact in a sequence.
  - `PATCH /api/comms/enrollments/:id` — pause / resume / cancel.
- OAuth
  - `GET /api/comms/oauth/gmail/authorize` — start Gmail OAuth flow.
  - `GET /api/comms/oauth/gmail/callback` — Gmail OAuth callback (persists refresh token).
  - `GET /api/comms/oauth/msft/authorize` — same for Microsoft Graph.
  - `GET /api/comms/oauth/msft/callback` — same.
- Webhooks
  - `POST /api/comms/webhook/sms` — Twilio inbound SMS + delivery status.
  - `POST /api/comms/webhook/gmail-push` — Gmail Pub/Sub push notification (incoming).
- Cron endpoints (require `Authorization: Bearer $CRON_SECRET`)
  - `GET /api/cron/gmail-sync` — Gmail delta sync tick (called every 5 min externally).
  - `GET /api/cron/graph-sync` — Microsoft Graph delta sync tick.
  - `GET /api/cron/sequences-tick` — every 15 min, advances due SequenceEnrollments.
  - `GET /api/cron/reconcile-threads` — hourly job that re-resolves contactId/leadId on EmailThread rows whose contactId is null (see §10 cross-milestone reconciliation).
- Health
  - `GET /api/comms/health` — returns 200 + JSON `{status, gmailReachable, graphReachable, twilioReachable, pgBossQueued}` for CI + monitoring.

**Events emitted (LISTEN/NOTIFY):**
- `message.received` on channel `crm_message` — every inbound email or SMS. Payload does NOT include a discriminant/`eventName` field (see §8).

**Events consumed:**
- `lead.upserted-from-import` on channel `crm_lead_sync` (from Agent A) — used to trigger thread-to-contact reconciliation when a contact CSV lands. See §10 cross-milestone. Payload MUST be parsed tolerantly: strip any `eventName`/`type` discriminant if present (see §8) since cross-brief drift means A's emitters may or may not include it depending on planner resolution.

## 3. What this slice does NOT touch

- **Agent A tables** (Lead, Contact, ContactPhone, ContactEmail, ContactUrl, Opportunity, Task, Activity, CustomFieldDefinition, CustomFieldValue, SavedView, CustomActivityType, Attachment, ImportBatch, DealFlowDerivedSignal). You SELECT from them freely (join keys, merge field resolution) but never INSERT/UPDATE/DELETE.
- **Agent B tables** (DialSession, Call, CallLeg, PacingMetric). Read-only.
- **Agent C tables** (DncSuppression, LitigatorSuppression, MobileLineCache, CallingWindowConfig, HolidaySuppressionDate, ScrubLog). You do NOT write to these. STOP handling goes through the HTTP contract at `/api/compliance/dnc/internal` (confirmed to exist per Blocking Issue B.1 resolution).
- **`ContactPhone.outboundSmsBlocked`** — decorative from Agent D's point of view. The schema field exists on ContactPhone (Agent A owned); Agent D never writes it. It is Agent A's responsibility to update this flag if they choose, likely by consuming Agent C's `scrub.completed` event. Do not read this field to decide whether to send — always call `/api/compliance/scrub` inline (fail-closed) instead. This is the authoritative gate.
- **DealFlow's Outlook Graph token.** DealFlow has a read-only Graph token for inbox intelligence. You do NOT reuse it. You register your OWN OAuth app with `mail.send` + `mail.read` scopes and run a separate consent flow.
- **Calendar writes.** Do not create, modify, or delete calendar events. Master Planner Brief safety rule: calendar writes are only permitted from the chat surface (not this slice) and only when the user explicitly requests. This slice is email + SMS only.
- **Email deletion / archival / move.** DealFlow's Outlook side is strictly GET-only on mail endpoints; this CRM slice sends and reads via its own OAuth, but you never delete or move mail out of Ryan's mailbox. Only send + read.

## 4. Environment / secrets

All secrets injected via Doppler at runtime. The repo has `.env.example` only — never commit real secrets.

**Every agent needs:**
- `DATABASE_URL_MAIN` — the `dealflow_crm` logical DB on Railway.
- `CRON_SECRET` — bearer secret for cron endpoints.
- `SENTRY_DSN`
- `SENTRY_ENVIRONMENT` — `dev` | `staging` | `production`.

**Agent D additionally needs:**
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID` — the Messaging Service that wraps the 10DLC campaign. Populated after 10DLC clears.
- `TWILIO_10DLC_BRAND_ID` — populated once Trust Hub Brand registration completes.
- `TWILIO_10DLC_CAMPAIGN_ID` — populated once campaign registration completes.
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_PUBSUB_TOPIC` — the Pub/Sub topic that Gmail push publishes to (created in GCP console).
- `GMAIL_PUBSUB_VERIFICATION_TOKEN` — shared token you check in the push webhook.
- `MSFT_GRAPH_CLIENT_ID`
- `MSFT_GRAPH_CLIENT_SECRET`
- `MSFT_GRAPH_TENANT_ID` — usually `common` for multi-tenant OAuth.
- `OAUTH_REDIRECT_BASE` — `https://<domain>/api/comms/oauth` — base URL for redirect URIs.
- `OAUTH_TOKEN_ENCRYPTION_KEY` — 32-byte key (base64) for AES-256-GCM at-rest encryption of refresh tokens.
- `PG_BOSS_SCHEMA` — usually `pgboss`. pg-boss creates its own schema on first boot.

**TBD until Ryan tells you:**
- Which Gmail address Ryan connects for send (his Elliman address? A dedicated broker@ alias? Confirm before enabling send in production).
- The public HTTPS base URL for webhooks (`OAUTH_REDIRECT_BASE`, Twilio Messaging webhook, Gmail push endpoint). For local dev, use an ngrok tunnel and note the tunnel URL in `.env.local` during development.

## 5. Repo layout + worktree setup

The repo already exists at `dealflow-crm/`. The planner has scaffolded:
- `CONTRACTS.md` (full Phase 0 contracts, committed).
- `contracts/reference/close-openapi.json`
- `contracts/events/` (Zod schemas per event).
- `contracts/http/` (OpenAPI-style docs for cross-slice endpoints).
- `contracts/mocks/comms/` (empty — you populate; this is a mock OF Agent D that other agents will use).
- `contracts/tests/` (contract test suite; you extend for your slice).
- `prisma/schema.prisma` (full frozen schema, §7).
- `src/app/` (Next.js App Router skeleton).
- `src/lib/shell/` (app shell: singleton-org `getCurrentOrgId()`, shadcn/ui base, Sentry + pino + correlation-ID middleware, keyboard-shortcut hook).
- `src/lib/comms/` (empty — this is YOUR module).
- `scripts/`
- `.env.example`

**Mocks that Agent D CONSUMES** (`contracts/mocks/{compliance,twilio,gmail,graph}/`) are NOT pre-scaffolded — **you build them as part of Gate 1 setup**. See §12 Gate 1 for acceptance criteria for each mock. Each mock is a minimal HTTP server (Fastify or Node http) that serves canned fixtures matching the contract Zod schemas. Ownership note: these mocks live in the shared `contracts/mocks/` folder, so if a later executor iterates on their real service and needs to update the mock behavior, you don't lose your work — the mock is contract-shaped, not implementation-shaped.

**Set up your worktree (run in `dealflow-inbox-intelligence`'s sibling `dealflow-crm/`):**

```bash
cd /path/to/dealflow-crm
git fetch origin
git worktree add worktrees/agent-d agent-d
cd worktrees/agent-d
pnpm install
doppler setup           # link to the dealflow-crm project + dev config
cp .env.example .env.local   # only if you need local override
```

Do all your work in `worktrees/agent-d`. Commit to branch `agent-d`. Never touch `main` directly. When contracts change (which they shouldn't — but if they do), run `git pull origin main` in your worktree.

**Your module layout inside `src/lib/comms/`:**
```
src/lib/comms/
├── index.ts                     # public exports
├── health.ts                    # /api/comms/health handler
├── db.ts                        # prisma client accessor for this slice
├── events.ts                    # emit LISTEN/NOTIFY on crm_message
├── correlation.ts               # correlation-ID helpers (thin wrapper on shell/)
├── oauth/
│   ├── crypto.ts                # AES-256-GCM encrypt/decrypt refresh tokens
│   ├── gmail.ts                 # Gmail OAuth flow + token refresh
│   ├── msft.ts                  # Microsoft Graph OAuth flow + token refresh
│   └── store.ts                 # OAuthCredential CRUD
├── email/
│   ├── gmail-client.ts          # Gmail API wrapper (googleapis)
│   ├── gmail-sync.ts            # full sync + delta sync via historyId
│   ├── gmail-push.ts            # Pub/Sub push handler
│   ├── graph-client.ts          # MS Graph wrapper
│   ├── graph-sync.ts            # delta sync (polling) + full backfill
│   ├── thread-reconstruct.ts    # EmailThread reconstruction algorithm
│   ├── thread-reconcile.ts      # re-resolve contactId/leadId on unlinked threads (new)
│   ├── send.ts                  # unified email-send
│   └── parse.ts                 # RFC 5322 envelope parsing helpers
├── sms/
│   ├── twilio-client.ts         # Twilio Messaging wrapper
│   ├── send.ts                  # SMS send via Messaging Service SID
│   ├── inbound.ts               # inbound SMS webhook handler
│   └── stop-handler.ts          # STOP/STOPALL/UNSUBSCRIBE → DNC (HTTP path only, per B.1)
├── templates/
│   ├── render.ts                # merge-field renderer
│   └── crud.ts
├── sequences/
│   ├── enroll.ts                # POST /api/comms/enrollments handler
│   ├── tick.ts                  # cron tick — advances due enrollments
│   ├── schedule.ts              # blackout-date + timezone-aware scheduler (luxon)
│   └── crud.ts
├── dedup/
│   └── outbound-echo.ts         # sent-mail echo dedup (see §10)
├── jobs/
│   ├── boss.ts                  # pg-boss singleton
│   ├── queues.ts                # queue name constants
│   ├── outbound-email.ts        # retry-with-backoff email send worker
│   ├── outbound-sms.ts          # retry-with-backoff SMS send worker
│   ├── inbound-retry.ts         # retry-with-backoff inbound sync worker
│   └── lead-import-consumer.ts  # LISTENer on crm_lead_sync → enqueues reconcile
└── clients/
    └── compliance.ts            # HTTP client for /api/compliance/dnc/internal + scrub (tolerant shape mapping)
```

**Mock module layout (`contracts/mocks/`):**
```
contracts/mocks/
├── compliance/server.ts         # /scrub, /dnc/internal, /callable-now (shape-locked)
├── twilio/server.ts             # /2010-04-01/Accounts/.../Messages.json, signature-check bypass flag
├── gmail/server.ts              # users.threads.list, .get, .history.list, .messages.send, .watch
└── graph/server.ts              # /me/mailFolders/inbox/messages/delta, /me/sendMail
```

Each mock server: HTTP on a known port from env (`COMPLIANCE_MOCK_PORT=4001`, etc.), fixture-backed responses in `contracts/mocks/<vendor>/fixtures/*.json`, health endpoint at `GET /_mock/health`, and a `--record` flag noted as future-work but not implemented for MVP. Each mock exports its Zod-validated response schema so contract tests can assert conformance.

**App Router files you create (`src/app/api/comms/...`, `src/app/api/cron/...`):**
- `src/app/api/comms/messages/route.ts` (GET, POST)
- `src/app/api/comms/messages/[id]/route.ts` (GET)
- `src/app/api/comms/threads/route.ts` (GET)
- `src/app/api/comms/threads/[id]/route.ts` (GET)
- `src/app/api/comms/templates/route.ts` + `[id]/route.ts`
- `src/app/api/comms/sequences/route.ts` + `[id]/route.ts` + `[id]/steps/route.ts`
- `src/app/api/comms/enrollments/route.ts` + `[id]/route.ts`
- `src/app/api/comms/oauth/gmail/authorize/route.ts` + `callback/route.ts`
- `src/app/api/comms/oauth/msft/authorize/route.ts` + `callback/route.ts`
- `src/app/api/comms/webhook/sms/route.ts`
- `src/app/api/comms/webhook/gmail-push/route.ts`
- `src/app/api/comms/health/route.ts`
- `src/app/api/cron/gmail-sync/route.ts`
- `src/app/api/cron/graph-sync/route.ts`
- `src/app/api/cron/sequences-tick/route.ts`
- `src/app/api/cron/reconcile-threads/route.ts`

**UI mount points (planner scaffolded routes; you plug in):**
- `src/app/(app)/inbox/page.tsx` — unified email inbox / conversation list.
- `src/app/(app)/inbox/[threadId]/page.tsx` — thread view.
- `src/app/(app)/sequences/page.tsx` — sequence list + editor.
- `src/app/(app)/templates/page.tsx` — template library.
- `src/app/(app)/settings/comms/page.tsx` — connect Gmail / MS Graph OAuth, view sync status, view 10DLC status.

Default to shadcn/ui unless the shell already provides something. Use react-hook-form + zod for forms. UI is not gated for Gate 1 boot (see §12), but Ryan will want inbox + sequence editor + settings usable at handoff.

## 6. Ryan-specific gotchas (memorize)

- **dotenv load order:** `import 'dotenv/config'` MUST be the first import of any script that touches DB — else Prisma silently defaults to localhost and your test data goes to nowhere. Every script in `scripts/` starts with `import 'dotenv/config'` as line 1. In Next.js API routes, Next handles env loading; only affects standalone scripts.
- **Prisma regenerate:** run `npx prisma generate` between `pnpm prisma migrate dev` and any `tsc`/`vitest` run. Stale generated types will mask real errors.
- **iCloud duplicate files:** the parent repo lives in iCloud Drive. iCloud silently creates ` 2.tsx` / ` 2.ts` shadow files. Before every grep-based audit, run `find src -name "* 2.ts" -o -name "* 2.tsx"` and delete the shadows. Add a `.gitignore` line: `**/*\ 2.ts`, `**/*\ 2.tsx`.
- **Prisma sequential .create() is slow on Railway:** ~90ms/row over network. For any bulk write >100 rows (Gmail backfill: expect thousands), use `prisma.$transaction` batches or `createMany({ skipDuplicates: true })` for a single round-trip. Historical email backfill is the concrete case here.
- **Ship-when-tested.** If gate criteria pass, do not gate on extra approvals.
- **Minimum-viable-fix.** Do not ladder up to multi-phase plans + risk registers on prototype work.
- **Prefer stronger model:** Claude Sonnet 4.6 for any LLM call on a product surface (there are none in this slice unless you decide to add AI-suggested reply drafting — hold off; not in scope). gpt-4o-mini only for cheap utility.
- **Do not rely on Outlook auto-refresh.** Ryan re-auths ~hourly on DealFlow's read-only Graph side. Your CRM Graph OAuth is a separate app with `offline_access` scope, so refresh tokens should work — BUT plan for manual re-auth UX (Settings page: "Reconnect Outlook" button).

## 7. Complete Prisma schema — tables this slice owns

The six tables below (Message, EmailThread, MessageTemplate, Sequence, SequenceStep, SequenceEnrollment) already exist in the shared `prisma/schema.prisma`. You do NOT run a migration to create them — running `prisma migrate dev --name comms-init` would produce an empty migration. Skip that step.

The ONLY migration you run is `comms-oauth-credentials`, which adds the OAuthCredential table — and only AFTER planner has resolved Blocking Issue B.2 (schema addition approval). If planner has not blessed the addition by Milestone 2.1 start, STOP and route to planner.

```prisma
// ── Agent D — Communications ─────────────────────────────────────────
model Message {
  id String @id @default(cuid())
  organizationId String
  leadId String?
  contactId String?
  userId String?
  channel String           // email|sms
  direction String         // incoming|outgoing
  status String            // inbox|draft|scheduled|outbox|sent|error  (see B.3 for delivery-state resolution)
  providerDeliveryState String?  // ADDED IFF planner resolves B.3 with option (b) — raw Twilio state
  threadId String?
  fromAddress String
  toAddresses String[] @default([])
  ccAddresses String[] @default([])
  bccAddresses String[] @default([])
  subject String?
  bodyText String?
  bodyHtml String?
  smsRemotePhone String?
  smsLocalPhone String?
  templateId String?
  sequenceId String?
  sequenceEnrollmentId String?
  providerMessageId String? @unique
  cost Decimal? @db.Decimal(10, 4)
  errorMessage String?
  dateScheduled DateTime?
  dateSent DateTime?
  activityAt DateTime @default(now())
  dateCreated DateTime @default(now())
  @@index([organizationId, activityAt(sort: Desc)])
  @@index([threadId])
  @@index([providerMessageId])
}

model EmailThread {
  id String @id @default(cuid())
  organizationId String
  leadId String?
  contactId String?
  subject String
  participants String[] @default([])
  messageCount Int @default(0)
  firstMessageAt DateTime
  lastMessageAt DateTime
  providerThreadId String? @unique
  createdAt DateTime @default(now())
  @@index([organizationId, lastMessageAt(sort: Desc)])
}

model MessageTemplate {
  id String @id @default(cuid())
  organizationId String
  name String
  channel String
  subject String?
  bodyText String
  bodyHtml String?
  mergeFields String[] @default([])
  createdAt DateTime @default(now())
  @@index([organizationId, channel])
}

model Sequence {
  id String @id @default(cuid())
  organizationId String
  name String
  description String?
  channel String           // email|sms|mixed
  blackoutDates String[] @default([])  // YYYY-MM-DD (contact-local calendar days)
  createdAt DateTime @default(now())
  steps SequenceStep[]; enrollments SequenceEnrollment[]
  @@index([organizationId])
}

model SequenceStep {
  id String @id @default(cuid())
  sequenceId String
  ordinal Int
  delayHours Int
  channel String
  templateId String
  createdAt DateTime @default(now())
  sequence Sequence @relation(fields: [sequenceId], references: [id], onDelete: Cascade)
  @@index([sequenceId, ordinal])
}

model SequenceEnrollment {
  id String @id @default(cuid())
  organizationId String
  sequenceId String
  contactId String
  status String @default("active")   // active|paused|finished|cancelled|error
  currentStepId String?
  enrolledAt DateTime @default(now())
  finishedAt DateTime?
  sequence Sequence @relation(fields: [sequenceId], references: [id], onDelete: Cascade)
  @@index([organizationId, status])
  @@index([contactId, status])
}
```

**OAuthCredential — contingent on planner bless of Blocking Issue B.2.** Add via migration `comms-oauth-credentials` after planner confirmation. Do not add before.

```prisma
model OAuthCredential {
  id String @id @default(cuid())
  organizationId String
  provider String              // gmail|msft
  emailAddress String          // the account this token is for
  refreshTokenCiphertext String
  refreshTokenIv String
  refreshTokenTag String
  accessToken String?          // short-lived; nullable, refreshed as needed
  accessTokenExpiresAt DateTime?
  scopes String[] @default([])
  gmailHistoryId String?       // last-processed historyId for Gmail delta sync
  graphDeltaLink String?       // last-processed @odata.deltaLink for Graph delta sync
  gmailWatchExpiresAt DateTime?
  status String @default("active")  // active|reauth_required|error
  connectedAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([organizationId, provider, emailAddress])
  @@index([organizationId, provider])
}
```

Encrypt the refresh token at write time with AES-256-GCM using `OAUTH_TOKEN_ENCRYPTION_KEY`. Store ciphertext + IV + auth tag in the three fields above. Access tokens are short-lived (Gmail: 1 hour; Graph: 1 hour), refresh on demand from the refresh token. Do not encrypt access tokens (short-lived, rotated frequently, not worth the complexity — document this call in the module README).

## 8. Event catalog

**Events YOU emit** (via Postgres `NOTIFY` in the same transaction as the state change):

| Event | Channel | When | Payload |
|---|---|---|---|
| `message.received` | `crm_message` | Every inbound email or SMS after row is inserted. | `{ messageId: string, channel: "email" \| "sms", contactId?: string, leadId?: string, correlationId: string }` |

**No other events emitted.** In particular:
- `sms.stop-received` is NOT emitted (B.1 resolved to HTTP path — see Blocking Issue B.1).
- No delivery-state event is emitted (Message.status/providerDeliveryState is polled/queried, not fanned out).

**IMPORTANT — payload shape (cross-brief consistency):** The `message.received` payload does NOT include an `eventName` field, and does NOT include a `type` discriminant. SHARED_CONTEXT §5 specifies exactly `{ messageId, channel, contactId?, leadId?, correlationId }`. The channel name (`crm_message`) is the routing signal; the eventName was drift from an earlier draft. Per the cross-brief critique, some other agents' emitters may have historically included `eventName`/`type` fields — the recommended lock is to drop them everywhere. **Do not add fields. Do not add a discriminant.** Consumers of D's events (Agent A activity projector) must not rely on a discriminant field being present.

Emit inside `prisma.$transaction`:

```ts
await prisma.$transaction(async (tx) => {
  const msg = await tx.message.create({ data: {...} });
  await tx.$executeRaw`SELECT pg_notify('crm_message', ${JSON.stringify({
    messageId: msg.id,
    channel: msg.channel,
    contactId: msg.contactId ?? undefined,
    leadId: msg.leadId ?? undefined,
    correlationId,
  })})`;
});
```

**Postgres NOTIFY payload size:** Postgres caps NOTIFY payloads at 8000 bytes. Current payload is tiny. If you later add anything (subject preview, body snippet, etc.), you WILL hit that cap and it will silently truncate/error. Add nothing without contract-change routing.

Zod schema for `message.received` lives at `contracts/events/message-received.ts` (planner-scaffolded). Import it and validate every emit + parse in tests.

**Events YOU consume:**

| Event | Channel | Why you listen | Handler |
|---|---|---|---|
| `lead.upserted-from-import` | `crm_lead_sync` | Trigger thread-to-contact reconciliation after CSV import lands contacts | `jobs/lead-import-consumer.ts` — enqueue pg-boss `reconcile-threads` job with `{ importBatchId, correlationId }` |

You DO open a `LISTEN` connection for this slice, on channel `crm_lead_sync`. Keep it thin: the LISTENer's only job is to enqueue a pg-boss job for the actual reconciliation work. The `crm-events` SSE bridge handles browser fan-out for user-facing surfaces; internal consumers use their own LISTEN connections as needed.

**Cross-brief note (per critique):** SHARED_CONTEXT §5 currently lists only Agent A as consumer of `lead.upserted-from-import`. Agent D adds itself as a consumer. This is additive and benign; planner should update SHARED_CONTEXT §5 to list D as a documented consumer, but D does not block on this update.

**Payload tolerance on consumption:** parse the incoming `lead.upserted-from-import` payload leniently. If a `eventName` or `type` field is present (drift from Agent A's emitter), strip it before validating. Only `{ leadId, sourceLabel, importBatchId, correlationId }` matter to D. Use Zod `.passthrough()` or `.strip()` explicitly to make the tolerance intentional.

## 9. HTTP contracts

**Endpoints YOU expose** — every endpoint requires `x-correlation-id` header (middleware auto-generates if missing) and returns JSON.

- `GET /api/comms/messages?contactId=<id>&channel=email|sms&direction=incoming|outgoing&limit=50&cursor=<id>`
  - Response: `{ messages: Message[], nextCursor: string | null }`
- `POST /api/comms/messages`
  - Body (email): `{ channel: "email", contactId?: string, leadId?: string, toAddresses: string[], ccAddresses?: string[], bccAddresses?: string[], subject?: string, bodyHtml: string, bodyText?: string, templateId?: string, mergeContext?: Record<string, unknown>, scheduleAt?: string /*ISO*/ }`
  - Body (sms): `{ channel: "sms", contactId?: string, leadId?: string, contactPhoneId: string, bodyText: string, templateId?: string, mergeContext?: Record<string, unknown>, scheduleAt?: string }`
  - Response: `{ messageId: string, status: "outbox"|"scheduled"|"sent"|"error" }`
  - **Precondition for SMS:** call Agent C's `/api/compliance/scrub` with the phone. If not callable, return 409 with reason. Fail-closed.
- `GET /api/comms/messages/:id` — full row.
- `GET /api/comms/threads?contactId=<id>&limit=50` — threads participating.
- `GET /api/comms/threads/:id` — thread + messages ascending by activityAt.
- `GET/POST/PATCH/DELETE /api/comms/templates[/:id]`
- `GET/POST/PATCH/DELETE /api/comms/sequences[/:id]`
- `GET /api/comms/sequences/:id/steps`
- `POST /api/comms/enrollments` — `{ sequenceId, contactId }` → `{ enrollmentId, currentStepId, nextStepDueAt }`
- `PATCH /api/comms/enrollments/:id` — `{ status: "paused"|"active"|"cancelled" }`
- OAuth (`GET /api/comms/oauth/{gmail|msft}/authorize` — redirects to provider; `.../callback` — persists token, redirects to `/settings/comms`).
- `POST /api/comms/webhook/sms` — Twilio inbound. Verify `X-Twilio-Signature` header against `TWILIO_AUTH_TOKEN`. Handle STOP/HELP + delivery status callbacks. Return `<Response></Response>` TwiML.
- `POST /api/comms/webhook/gmail-push` — Gmail Pub/Sub. Verify `GMAIL_PUBSUB_VERIFICATION_TOKEN` in query string. Enqueue delta sync job; return 200 immediately (Pub/Sub retries on non-2xx).
- `GET /api/cron/{gmail-sync|graph-sync|sequences-tick|reconcile-threads}` — `Authorization: Bearer $CRON_SECRET`. Return `{ ran: true, processed: number, durationMs: number }`.
- `GET /api/comms/health` — `{ status: "ok"|"degraded", checks: {...} }`. HTTP 200 if ok, 503 if degraded.

**Endpoints YOU consume** (from other slices):

- `POST /api/compliance/scrub` (Agent C — confirmed in SHARED_CONTEXT §6)
  - Body: `{ phones: string[], contactPhoneIds?: string[] }`
  - Response: `{ results: [{ phone, callable: boolean, reasons: string[] }] }`
  - **Fail-closed:** on timeout/error, treat every phone as `callable:false`.
  - Call before every SMS send. Cache result for 10s only if callable=true; never cache negatives (compliance status can change any time).
  - **`reasons[]` vocabulary (per cross-brief critique):** Agent C locks a frozen `REASON_CODES` enum (`internal_dnc`, `federal_dnc`, `state_dnc`, `litigator`, `outside_calling_window_hour`, `outside_calling_window_day`, `holiday_suppressed`, `timezone_unresolved`, `mobile_line_unverified`, `compliance_unavailable`, etc.). Do NOT invent reason strings when synthesizing fail-closed responses in the compliance mock — draw values from that enum. Contract tests assert reason values are drawn from the enum. If planner has not yet published REASON_CODES centrally, use the values named above as the working set and route additions through §14.

- `POST /api/compliance/dnc/internal` (Agent C — **CONFIRMED** per Blocking Issue B.1 resolution)
  - Body: `{ phone: string, source: "internal", addedBy?: string, reason?: string, correlationId: string }`
  - Response (merged/locked, per cross-brief critique): `{ id: string, phone: string, source: "internal", addedAt: string /*ISO*/, added: boolean }`.
    - `id` = the DNC row id (aliased as `dncId` in the D client wrapper for backward-compat with earlier code).
    - `added: true` = new row inserted; `added: false` = idempotent, row already present.
  - **Client tolerance:** `clients/compliance.ts` maps whatever shape Agent C actually ships to this canonical merged shape. If C's response omits `added`, default `added=true`. If C's response uses `dncId` instead of `id`, map `dncId → id`. This is the ONE cross-slice write in the whole system; do not let a subset-shape from C break the STOP flow.
  - Called by inbound SMS STOP handler.

- `POST /api/compliance/callable-now` (Agent C — informational for D; D calls `/scrub` in the send path, but the mock must serve this endpoint for contract tests to run under a unified compliance mock)
  - Batch cap: **100** contactPhoneIds per request. Requests exceeding cap return HTTP 413 in the mock; the real C service is expected to enforce the same cap per critique. D does not currently call this endpoint from send paths, but the mock implements it so cross-slice contract tests can share the compliance mock.
  - Response (shape-locked per critique): `{ results: [{ contactPhoneId: string, phone: string, callable: boolean, reasons: string[], reasonDetails?: object }] }`. Note both `contactPhoneId` AND `phone` are present — earlier drift had them missing from different consumers. The mock returns both.

Base URL for cross-slice HTTP calls in dev: from the same Next.js app, use relative URLs. In tests (Gate 1), all cross-slice calls go through mocks in `contracts/mocks/`.

## 10. Milestones + implementation plan

### Milestone 1 — Day 1 external work: 10DLC registration

**This is blocking. Ryan must be looped in TODAY.**

Steps (executor + Ryan collaborate):

1. Log in to Twilio Console → Trust Hub → Register Brand.
2. Choose "Sole Proprietor" (Ryan is one person). Fill in: legal name, SSN or EIN, business address (Ryan's Elliman office), business email, business URL (a public-facing site — for real-estate use, his `douglaselliman.com` profile page works; confirm with Ryan). Cost: ~$4/mo.
3. Submit Campaign registration under the brand. Use case: "Real Estate Agent — Prospect & Client Outreach." Provide:
   - 2-3 sample messages (write these; e.g., "Hi {firstName}, this is Ryan from Douglas Elliman. I have a coming-soon listing on your block. Reply YES for details or STOP to opt out.").
   - Opt-in evidence description ("Consumer provides phone number via signed listing agreement, buyer representation agreement, or in-person conversation; opt-in language is stored in the CRM").
   - Opt-out handling: "Reply STOP to opt out."
4. Create a Twilio Messaging Service. Attach the campaign. Add at least one long-code or 10DLC phone number under the Messaging Service. Store the Messaging Service SID in Doppler as `TWILIO_MESSAGING_SERVICE_SID` once vetting clears.
5. Vetting takes 1-4 weeks. Track weekly with Ryan.

**While waiting: do NOT write SMS code paths that will fail silently.** Set a `sms.enabled` config flag defaulting to `false`. All SMS send handlers return HTTP 503 with `{ error: "sms_pending_10dlc" }` when the flag is off. Flip the flag when SIDs land.

**Proof-of-done for M1:** Twilio Trust Hub shows Brand + Campaign statuses (starts "SUBMITTED"). Ryan confirms filing.

### Milestone 2 — Weeks 1-2: Gmail OAuth + full sync + delta sync + EmailThread reconstruction

The meatiest engineering piece. This is where the coverage floor pays off.

**Sub-milestone 2.1 — OAuth + credential storage.**

Prerequisite: Blocking Issue B.2 resolved (planner blesses OAuthCredential addition). Then run `pnpm prisma migrate dev --name comms-oauth-credentials` and `pnpm prisma generate`.

Files:
- `src/lib/comms/oauth/crypto.ts` — AES-256-GCM using `OAUTH_TOKEN_ENCRYPTION_KEY`. Functions: `encrypt(plain: string) → {ciphertext, iv, tag}`, `decrypt(record) → string`.
- `src/lib/comms/oauth/store.ts` — `upsertCredential`, `getCredential(orgId, provider, emailAddress)`, `markReauthRequired(id)`.
- `src/lib/comms/oauth/gmail.ts` — using `googleapis`. Functions: `getAuthUrl(orgId, state)`, `exchangeCode(code) → {refreshToken, accessToken, emailAddress}`, `refreshAccessToken(cred) → {accessToken, expiresAt}`.
- Route: `src/app/api/comms/oauth/gmail/authorize/route.ts` — redirects to Google consent screen. State param = signed HMAC of `orgId + timestamp` to prevent CSRF.
- Route: `src/app/api/comms/oauth/gmail/callback/route.ts` — validates state, exchanges code, calls `store.upsertCredential`, redirects to `/settings/comms?connected=gmail`.

Tests (Vitest):
- `crypto.test.ts` — encrypt/decrypt round-trip; wrong key fails; tampered ciphertext fails auth-tag check.
- `oauth-state.test.ts` — state HMAC validation.
- `oauth-callback.test.ts` — mock googleapis; POST callback with valid code → credential stored, redirect issued.

**Sub-milestone 2.2 — Gmail full sync (initial backfill).**

Files:
- `src/lib/comms/email/gmail-client.ts` — thin wrapper. `listThreads(after, pageToken)`, `getThread(threadId)`, `getHistory(startHistoryId)`, `sendMessage(raw)`, `watch(topicName)`.
- `src/lib/comms/email/gmail-sync.ts`:
  - `fullBackfill(orgId, emailAddress, sinceIso)` — walks `users.threads.list` with `q=after:{sinceIso}` (defaults to 90 days). For each thread, calls `getThread`, then hands off to `thread-reconstruct.ts`. Batches Message inserts via `createMany({ skipDuplicates: true })` on `providerMessageId`.
  - `deltaSync(orgId, credential)` — uses `credential.gmailHistoryId`. Calls `users.history.list(startHistoryId=historyId)`. For each `messageAdded`, fetch message, upsert Message, update thread. Updates `credential.gmailHistoryId` to the latest ONLY after the batch succeeds (never lose a message).
- `src/lib/comms/email/parse.ts` — parse RFC 5322 headers. Extract: `From`, `To`, `Cc`, `Bcc`, `Subject`, `Message-ID`, `In-Reply-To`, `References`, `Date`. Gmail returns the raw base64url payload; use `googleapis`'s decoded fields when possible.
- `src/lib/comms/email/thread-reconstruct.ts` — see 2.3.

Prefix all Gmail providerMessageIds as `gmail:<id>` and Graph as `msft:<id>` at write time (defensive namespacing — see Milestone 5).

Tests:
- `gmail-sync.test.ts` — mock `googleapis` client. Feed a canned thread list; assert Message rows + EmailThread row + `message.received` NOTIFYs match expected count. Use `pg-mem` or a test schema — do NOT hit real DB in unit tests.
- `gmail-sync-idempotent.test.ts` — run backfill twice; assert `createMany` skips duplicates and no duplicate `message.received` NOTIFYs (dedup at Message.providerMessageId).
- Rate-limit backoff test: mock 429 response, assert exponential backoff via pg-boss retry.

**Sub-milestone 2.3 — EmailThread reconstruction.**

Algorithm (`thread-reconstruct.ts`):

1. For each Gmail message, get Gmail's `threadId` (Gmail already threads for you — use this as `providerThreadId`).
2. Upsert `EmailThread` by `providerThreadId`. On upsert:
   - `subject` = subject of the FIRST message (chronologically) in the thread.
   - `participants` = union of all From + To + Cc addresses across the thread.
   - `firstMessageAt` = `min(activityAt)` of all messages.
   - `lastMessageAt` = `max(activityAt)`.
   - `messageCount` = count.
   - `leadId`/`contactId` = if any message's `fromAddress` or any recipient matches a `ContactEmail.email` in the org, attach the corresponding contactId + leadId (via ContactEmail → Contact → Lead). If multiple candidates, prefer the one with earliest message match. If none, leave null (thread stays "unlinked"; will be re-resolved by the reconcile job when contacts land).
3. Set `Message.threadId = EmailThread.id` on each row.

**Known-acceptable limitation:** per SHARED_CONTEXT §8 empirical findings, contact data (Mojo CSV) lands POST-BUILD. During Weeks 1-2, almost every thread will resolve to `contactId=null`. That's fine. The reconcile job (§10 cross-milestone below) closes the loop when contacts arrive.

**Edge cases you MUST handle (test cases):**
- Forward (`Fwd: subject`) — Gmail keeps it in the same thread; just process normally.
- Reply from an unknown participant — thread `participants` array grows.
- Thread merged/split by Gmail — Gmail's `threadId` is authoritative; if we see a message whose Gmail threadId doesn't match its `In-Reply-To` header's thread, trust Gmail's threadId.
- Mixed participants (BCC recipient replies) — new participant added, contact resolution retried.
- Multiple contacts in the org share an email domain — resolve by exact ContactEmail match, never by domain heuristics (would misroute).

Tests (`thread-reconstruct.test.ts`):
- Simple reply chain (3 messages, 2 participants) → 1 EmailThread, correct dates + count.
- Forward — thread stays intact.
- Reply from previously-unknown address → participants array updates.
- Contact resolution: seed a Contact with email `alice@example.com`, feed thread with `alice@example.com` as recipient → thread.contactId set.
- No matching contact → thread.contactId null.
- Race: two workers process same thread concurrently → assert idempotent upsert (unique constraint on providerThreadId protects).

**Sub-milestone 2.4 — Gmail push notifications (delta trigger).**

Files:
- `src/app/api/comms/webhook/gmail-push/route.ts` — verifies `GMAIL_PUBSUB_VERIFICATION_TOKEN` query param, decodes Pub/Sub envelope (base64 JSON with `emailAddress` + `historyId`), enqueues a pg-boss job `gmail-delta-sync` with `{ orgId, emailAddress, historyId }`.
- `src/lib/comms/jobs/inbound-retry.ts` — worker for `gmail-delta-sync`. Retries with exponential backoff on Gmail API errors (5xx, 429). Max 5 attempts over ~1 hour, then Sentry alert + mark credential `status='error'`.
- `src/lib/comms/email/gmail-sync.ts::renewWatch(cred)` — call `users.watch({topicName: GMAIL_PUBSUB_TOPIC})` weekly (Gmail push subs expire after 7 days). Schedule via pg-boss recurring job.

Tests:
- `gmail-push.test.ts` — POST valid envelope → job enqueued.
- Invalid token → 401.
- Malformed envelope → 200 with Sentry log (rationale: Google Pub/Sub retries non-2xx with exponential backoff up to 7 days, which stalls the entire push feed for that account. Better to swallow parse errors and alert than to stall).

**Sub-milestone 2.5 — Cron endpoint for periodic Gmail sync.**

Files:
- `src/app/api/cron/gmail-sync/route.ts` — bearer-auth. Iterates all active `OAuthCredential`s (provider=gmail, status=active). For each, if last delta sync was >5 min ago, enqueue `gmail-delta-sync`. Also checks `gmailWatchExpiresAt`; if <2 days from expiry, enqueue `gmail-renew-watch`.

Proof-of-done for M2: connect a real Gmail account in dev (Ryan's or a test address), run backfill, run delta sync, send a test email TO the connected address, watch it appear as a Message row + emit `message.received` NOTIFY. Coverage on `email/*` ≥ 85%.

### Milestone 3 — Templates + Sequence engine (email-only)

**Sub-milestone 3.1 — MessageTemplate CRUD.**

Files:
- `src/lib/comms/templates/crud.ts` — validated with zod. Fields: name, channel (email/sms), subject (email only), bodyText, bodyHtml (email only), mergeFields (auto-extracted from body via regex `{{[\w.\[\]]+}}`).
- Routes: `src/app/api/comms/templates/route.ts` + `[id]/route.ts` (GET, POST, PATCH, DELETE).

Tests: `templates.test.ts` — CRUD round-trip; `mergeFields` extracted correctly; delete cascades safely (a template referenced by a sequence step should NOT be deletable — return 409; enforce with a service-layer check, not FK cascade).

**Sub-milestone 3.2 — Merge-field renderer.**

File: `src/lib/comms/templates/render.ts`.

Syntax:
- `{{contact.firstName}}` — resolves via `Contact.name.split(' ')[0]` (contact.name is single-string).
- `{{contact.displayName}}`
- `{{lead.displayName}}`
- `{{lead.addresses.[0].address_1}}` — array indexing.
- `{{lead.primaryAddressSummary}}`
- `{{lead.custom.est_value}}` — resolves via CustomFieldValue lookup where CustomFieldDefinition.name='est_value' and objectType='lead' and objectId=leadId.
- `{{signature}}` — user's signature (User model has none; add as `mergeContext` at send time — Ryan pastes his standard signature into a settings page).

Missing merge fields render as empty string. Do NOT render the literal `{{...}}` (Ryan would notice and be annoyed).

Async because custom-field resolution hits DB. Function signature:
```ts
async function render(
  template: string,
  ctx: { orgId: string; leadId?: string; contactId?: string; extra?: Record<string, unknown> },
): Promise<string>
```

Tests (`render.test.ts`):
- Simple `{{contact.firstName}}` → resolves.
- Missing field → empty string.
- Nested `{{lead.addresses.[0].city}}` → array index.
- Custom field resolution — seed a CustomFieldValue → renders.
- Malicious template `{{__proto__}}` → empty string (do NOT allow prototype access).
- HTML-escape rule: for `bodyHtml` templates, escape merge-field values; for `bodyText`, no escape. Test both.

**Sub-milestone 3.3 — Sequence CRUD + Enrollment.**

Files:
- `src/lib/comms/sequences/crud.ts` — sequence + step CRUD. Steps have ordinal + delayHours + channel + templateId.
- `src/lib/comms/sequences/enroll.ts` — `POST /api/comms/enrollments` handler. Validates contact exists in org, sequence exists, no active enrollment already for this (contact, sequence). Creates enrollment with `currentStepId` = first step's id, `enrolledAt = now`, `status='active'`.
- Route: `PATCH /api/comms/enrollments/:id` — accepts `{ status: 'paused'|'active'|'cancelled' }`.

Tests: enrollment CRUD; duplicate enrollment blocked; pause/resume; cancel is terminal.

**Sub-milestone 3.4 — Sequence tick + blackout scheduling.**

**Date library: `luxon`.** Do not use `date-fns-tz`. Luxon's `Interval` math and `DateTime.setZone` avoid the DST double-fire bug class. Pick one, stick with it, all tests use it.

Files:
- `src/lib/comms/sequences/schedule.ts` — pure functions:
  - `nextStepDueAt(enrollment, steps, contactTimezone)` — returns UTC luxon `DateTime`. Sum of delayHours from step 1 through `currentStepId`.
  - `applyBlackoutDates(dueAt, blackoutDates, contactTimezone)` — if `dueAt` (converted to contact's local TZ) falls on a calendar date in `blackoutDates` (YYYY-MM-DD), defer to the NEXT calendar day (in contact-local TZ) whose YYYY-MM-DD is NOT in `blackoutDates`, preserving the same local hour+minute. If that next day is ALSO a blackout, iterate. DST-aware via luxon.

Spec clarification (this is the corrected version of the ambiguous test in the original brief): `blackoutDates` is a set of contact-local calendar dates the user does NOT want any send on. Deferral rule is "advance one local day at a time, keep advancing while the current date is in `blackoutDates`, then send at the same local hour+minute on the first non-blackout day." Weekends are NOT automatically blackout — if Ryan wants weekends off, he adds them to `blackoutDates` on the Sequence.

- `src/lib/comms/sequences/tick.ts` — the cron handler logic:
  1. Query all `SequenceEnrollment` where `status='active'`.
  2. For each, load its sequence + steps + contact + contact's timezone. **Timezone fallback (cross-brief consistency, per critique G2):** if `Contact.timezone` is null, use `America/New_York` as the local scheduling timezone for the sequence tick's own math. This is a display-layer/scheduling fallback and does NOT enter the compliance check for SMS steps — SMS steps still route through `POST /api/compliance/scrub` inline, which is authoritative (Agent C fail-closes on missing timezone). For email steps, timezone drives blackout-date interpretation only; there is no compliance-side timezone check for email.
  3. Compute `dueAt` for the current step. Apply blackout dates.
  4. If `dueAt <= now`: render template, insert Message (`status='outbox'`, `direction='outgoing'`, `sequenceId`, `sequenceEnrollmentId`), enqueue outbound send job. Advance `currentStepId` to next step or mark `finished`.
  5. Wrap each enrollment in its own transaction so one failure doesn't block others.
  6. If step render errors: set enrollment `status='error'` + Sentry alert.
- Route: `src/app/api/cron/sequences-tick/route.ts` — bearer-auth, calls tick.

Tests (`sequences-tick.test.ts` — CRITICAL PATH, this is Gate 3 core):
- Enrollment with step 1 delayHours=0, step 2 delayHours=48. At `now=enrolledAt+1h`, tick fires step 1 (outbox row exists, currentStepId advanced to step 2). At `now=enrolledAt+49h`, tick fires step 2. Use fake timers.
- **Blackout, single-day (corrected):** enrollment enrolled Friday 3pm ET, step 1 delayHours=24 → due Saturday 3pm. Sequence.blackoutDates = ['2026-08-08' /* Saturday */]. Sunday is NOT in blackoutDates. Assert deferral to **Sunday 3pm ET** (advance one day; Sunday is not blackout; send at same local hour). This matches the spec.
- **Blackout, multi-day:** same enrollment, blackoutDates = ['2026-08-08' /* Sat */, '2026-08-09' /* Sun */]. Assert deferral to **Monday 3pm ET**.
- DST transition: enrollment enrolled 2026-11-01 (fall-back Sunday) 1:30am local — verify no double-fire (classic DST bug). Use luxon `DateTime.plus({hours: N})` which honors zone rules, not manual hour arithmetic.
- **Timezone fallback:** enrollment with `Contact.timezone=null` → tick uses `America/New_York`; blackout-date interpretation uses ET; assert send fires at expected local hour in ET. (Documents the G2 fallback behavior.)
- Paused enrollment → tick skips.
- Cancelled enrollment → tick skips.
- Missing template → enrollment marked `status='error'`, no Message row.
- Sequence with 0 steps → enrollment finishes immediately.

**Sub-milestone 3.5 — Outbound email send worker.**

Files:
- `src/lib/comms/jobs/outbound-email.ts` — pg-boss worker for queue `send-email`. Reads Message row by id. Looks up OAuthCredential for org. Refreshes access token if expired. Sends via `gmail-client.sendMessage` or `graph-client.sendMessage` (based on `credential.provider`). On success: sets `providerMessageId` (with `gmail:` or `msft:` prefix), `status='sent'`, `dateSent=now`. On failure: retry with exponential backoff (pg-boss default 15/30/60/300s); after 5 attempts set `status='error'` + `errorMessage`, Sentry alert.
- Called from `POST /api/comms/messages` (for immediate send) and from `sequences/tick.ts` (for sequence sends).

**Outbound identity trick (for dedup — see cross-milestone below):** Before calling gmail-client.sendMessage, generate a client-side RFC 5322 Message-ID header (e.g., `<crm-<uuid>@dealflow-crm.local>`) and set `Message.providerMessageId = "gmail:<msg-id>"` in the SAME transaction as reading the outbound row. Gmail preserves the Message-ID header. When inbound sync later fetches the sent-folder copy, it will find the same Message-ID and the `@unique providerMessageId` constraint will short-circuit the insert. This is the ONLY dedup mechanism; there is no delete-and-swap logic.

Tests: mock Gmail sendMessage; happy path; API 500 retry; final failure sets error.

Proof-of-done for M3: create a template, create a 3-step email sequence with 24h/48h delays, enroll a contact, manually trigger the tick cron (with fake time) → three Message rows land in outbox, get sent via Gmail (in dev, use a test Gmail address; confirm in the inbox).

### Milestone 4 — Twilio Messaging integration (SMS)

Gated on Milestone 1 completing AND Blocking Issue B.3 resolved (delivery-state contract).

Files:
- `src/lib/comms/sms/twilio-client.ts` — wrapper on `twilio` SDK. `sendMessage({to, messagingServiceSid, body, statusCallback})`.
- `src/lib/comms/sms/send.ts`:
  1. Load contact + contactPhone.
  2. Precondition scrub: call `contracts/mocks` in tests or real `POST /api/compliance/scrub` in prod. If not callable, return 409 with the `reasons[]` array from C echoed back to the caller.
  3. Insert Message row `status='outbox'`, `direction='outgoing'`.
  4. Enqueue pg-boss `send-sms` job.
- `src/lib/comms/jobs/outbound-sms.ts` — worker. Sends via twilio-client. On success: `providerMessageId=twilioSid`, `status='sent'`. Delivery status flows in via webhook (below).
  - If B.3 resolved with option (a) — enum widened: update `Message.status` to the mapped Twilio state (`delivered`/`undelivered`/`failed`).
  - If B.3 resolved with option (b) — separate column: keep `Message.status` at `sent`, write raw Twilio state to `Message.providerDeliveryState`, move `Message.status` to `error` only on terminal Twilio failure (`undelivered|failed`).
- `src/lib/comms/sms/inbound.ts`:
  - Route: `src/app/api/comms/webhook/sms/route.ts`. Verify `X-Twilio-Signature`.
  - Two shapes:
    - Inbound message (Twilio POSTs `From`, `To`, `Body`, `MessageSid`, `AccountSid`, etc.). Parse; resolve Contact by phone (E.164 lookup in ContactPhone); insert Message `direction='incoming'`, `status='inbox'`; emit `message.received`.
    - Status callback (Twilio POSTs `MessageSid`, `MessageStatus`). Update per B.3 resolution above.
  - If inbound body matches `/^(stop|stopall|unsubscribe|cancel|end|quit)$/i` (after trim): call `stop-handler.ts`.
- `src/lib/comms/sms/stop-handler.ts`:
  - **HTTP path (confirmed per B.1 resolution):** POST to `/api/compliance/dnc/internal` with `{ phone, source: 'internal', addedBy: 'sms-stop', reason: 'sms_stop_reply', correlationId }`. Parse response tolerantly through the `clients/compliance.ts` wrapper (see §9) to handle either `{ id, phone, source, addedAt, added }` (merged/locked shape) or a subset. On HTTP failure (5xx/timeout): enqueue pg-boss `sms-stop-relay` retry job with exponential backoff; retry until success (this write is legally required, never give up short of 24h Sentry-critical escalation).
  - Do NOT emit `sms.stop-received` — that event does not exist per B.1 resolution.
  - Do NOT write `ContactPhone.outboundSmsBlocked` — that's an Agent A owned field. The DNC row (via C's DncSuppression) IS the authoritative block; downstream sends fail-closed via the inline scrub call.
  - Twilio's Advanced Opt-Out (enabled at campaign registration) sends the auto-reply "You have been unsubscribed" automatically. Confirm this is enabled in the campaign config; if not, send our own confirming reply.

Tests:
- `sms-send.test.ts` — scrub returns callable=true → Message row inserted, job enqueued; scrub callable=false → 409 with `reasons[]` echoed.
- `sms-inbound.test.ts` — Twilio signature verified; message row created; `message.received` emitted; STOP reply → HTTP POST to `/dnc/internal` (mocked); HELP reply → no DNC (Twilio auto-reply handles).
- `sms-status.test.ts` — delivery status callback updates status per B.3 resolution.
- `sms-stop-retry.test.ts` — `/dnc/internal` returns 500 → job re-enqueued; eventual success → no duplicate DNC row (tolerates `added: false` from idempotent C response).
- `sms-stop-shape-tolerance.test.ts` — mock C responds with subset `{ id, phone, source, addedAt }` (no `added` field) → wrapper defaults `added=true`, flow succeeds.
- Signature verification failure → 401.

Proof-of-done for M4: in dev with 10DLC live, send a real SMS to your own phone via `POST /api/comms/messages`; receive it; reply STOP; verify DNC row appears in Agent C's table (via the mock or via a live Agent C endpoint in staging).

### Milestone 5 — Microsoft Graph mirror

Same structure as M2 but for Outlook.

Files:
- `src/lib/comms/oauth/msft.ts` — MSAL Node or `@microsoft/microsoft-graph-client` OAuth. Scopes: `Mail.Read`, `Mail.Send`, `offline_access`. NOTE: this is a SEPARATE OAuth app from DealFlow's — do not reuse.
- `src/lib/comms/email/graph-client.ts` — Graph API wrapper.
- `src/lib/comms/email/graph-sync.ts` — polling delta sync (Graph push requires public HTTPS + subscription-renewal complexity; for MVP, poll `/me/mailFolders/inbox/messages/delta` every 5 min via cron). Store `@odata.deltaLink` in `credential.graphDeltaLink`.
- Route: `src/app/api/cron/graph-sync/route.ts` — bearer-auth; iterates active msft credentials.
- OAuth routes (authorize + callback).

Tests: mirror M2 tests but with mocked Graph responses. Thread reconstruction is the same algorithm — Graph exposes `conversationId` (analogous to Gmail threadId); use that as `providerThreadId`. Contact resolution shared with Gmail path.

**Important:** Graph message ids and Gmail message ids share a single `Message.providerMessageId` unique index. Since Gmail message-ids and Graph message-ids differ in format, collisions are impossible in practice, but PREFIX them defensively: `gmail:<id>` vs `msft:<id>`. That way if you ever need to disambiguate, you can, and outbound-echo dedup still works.

Proof-of-done for M5: connect a real Outlook account (Ryan's Elliman address — separately from DealFlow's read-only token, needs re-consent), backfill 90 days, delta sync, send/receive test email.

### Cross-milestone — Sent-mail dedup (outbound echo) — SINGLE AUTHORITATIVE ALGORITHM

Problem: CRM sends an email → provider (Gmail/Graph) accepts → provider puts it in Sent folder → next inbound sync pulls the same message back → without dedup, we'd insert a duplicate Message row.

**Chosen mechanism (this is the ONLY dedup path; do not implement delete-and-swap):**

1. When the outbound row is first inserted (from `POST /api/comms/messages` or `sequences/tick`), it has `status='outbox'` and `providerMessageId=NULL`.
2. In the outbound send worker (`jobs/outbound-email.ts`), BEFORE calling the provider's sendMessage: open a Prisma `$transaction`. Inside the transaction: `SELECT ... FOR UPDATE` the outbound Message row. Generate a client-side RFC 5322 Message-ID header (e.g., `<crm-<uuid>@dealflow-crm.local>`). Set `Message.providerMessageId = "gmail:<generated-msg-id>"` (or `msft:<...>` for Graph). Commit the transaction.
3. Call the provider's sendMessage with the pre-set Message-ID header. Providers preserve custom Message-IDs.
4. On success: UPDATE Message set `status='sent'`, `dateSent=now`.
5. When inbound sync later fetches the sent-folder copy (both Gmail and Graph return sent mail in delta feeds), it computes the providerMessageId from the message's Message-ID header, discovers the row already exists via the `@unique` constraint, and skips the insert (`createMany({ skipDuplicates: true })`).

**On provider send failure BEFORE step 4 lands `status='sent'`:** the row still has `providerMessageId` populated. That's fine — a subsequent inbound sync would still find no matching message in Gmail (send didn't complete), so no duplicate can arrive. Retry via pg-boss; on final failure, set `status='error'`. Leave providerMessageId as-is; it's a stable client-side identifier and no collision is possible.

**On P2002 during INBOUND sync insert:** something is wrong (this should never happen with pre-committed outbound IDs). Log to Sentry with the offending providerMessageId, skip the insert (do NOT delete anything — Activity rows on Agent A may reference existing rows).

Test: `outbound-echo.test.ts` — send outbound → outbound worker commits providerMessageId → simulate immediate inbound sync of same providerMessageId via `createMany({skipDuplicates: true})` → assert only one Message row exists AND it has `direction='outgoing'`. Assert P2002 is never thrown in the happy path.

### Cross-milestone — Thread-to-contact reconciliation (new)

Problem: contacts land POST-BUILD via Ryan's Mojo CSV import. Email threads synced before the import have `contactId=null`. When contacts arrive, we need to retroactively link them.

Solution:

1. `jobs/lead-import-consumer.ts` opens a persistent `LISTEN crm_lead_sync` connection on boot.
2. On any `lead.upserted-from-import` payload, enqueue pg-boss job `reconcile-threads` with `{ correlationId }` (throttled — at most one queued at a time; dedupe via pg-boss singleton key). Parse the incoming payload leniently (see §8 payload-tolerance note): strip any `eventName`/`type` discriminant if present, only require `{ leadId, sourceLabel, importBatchId, correlationId }`.
3. `email/thread-reconcile.ts` worker:
   - Query `EmailThread WHERE contactId IS NULL` in the org.
   - For each, run the same contact-resolution logic as `thread-reconstruct.ts` — match `participants[]` against `ContactEmail.email`.
   - If a match, UPDATE thread.contactId + thread.leadId. Also UPDATE all Message rows in that thread (contactId + leadId).
4. Cron backup: `GET /api/cron/reconcile-threads` runs the same worker every hour, in case a LISTEN event was missed.

Tests (`thread-reconcile.test.ts`):
- Thread with participants including `alice@example.com`, contactId=null. Seed a Contact with `alice@example.com`. Run reconcile → thread.contactId set, thread.leadId set, all message rows updated.
- Thread with no matching contact → thread stays unlinked.
- Idempotency: run reconcile twice → no double-writes, no drift.
- Payload-tolerance: feed a `lead.upserted-from-import` payload WITH an `eventName` field and WITH a `type` field → LISTENer strips them, still enqueues reconcile job successfully.

### Cross-milestone — pg-boss setup

Files:
- `src/lib/comms/jobs/boss.ts` — singleton pg-boss instance. Uses `DATABASE_URL_MAIN`. Schema `pgboss`.
- `src/lib/comms/jobs/queues.ts` — queue name constants: `send-email`, `send-sms`, `gmail-delta-sync`, `graph-delta-sync`, `gmail-renew-watch`, `reconcile-threads`, `sms-stop-relay`.
- Worker entrypoint: `scripts/comms-worker.ts` — starts pg-boss, registers handlers, runs until SIGTERM. Deploys to Railway as a separate service. First line: `import 'dotenv/config'`.

Ryan's memory item — sequential Prisma writes are slow on Railway. In `gmail-sync.ts::fullBackfill`, DO NOT loop `prisma.message.create()` per message. Accumulate arrays and use `prisma.message.createMany({ skipDuplicates: true, data: batch })` in batches of 200. Same for EmailThread upserts (though upsert-many is trickier — use `$transaction` with individual upserts in batches of 50).

### Cross-milestone — SSE bridge readiness

The `crm-events` SSE bridge (a separate Railway service, planner-owned) subscribes to `crm_message` LISTEN and pushes to the browser. You do NOT build the bridge. You just NOTIFY correctly. Verify your NOTIFY payload matches the Zod schema in `contracts/events/message-received.ts` (Gate 2). No `eventName` field, no `type` discriminant.

Reminder: Postgres NOTIFY payload cap is 8000 bytes. Current payload is well under. Do not add fields (subject preview, body snippet, etc.) — it would break silently as payloads grow. Any addition routes through §14 contract change.

## 11. UI mount points

The app shell provides routing scaffolds; you fill them.

- `src/app/(app)/inbox/page.tsx` — list of EmailThreads for the connected accounts, sorted by lastMessageAt desc. Left panel: threads. Right panel: selected thread + messages + reply composer.
- `src/app/(app)/inbox/[threadId]/page.tsx` — full-screen thread view (mobile).
- `src/app/(app)/sequences/page.tsx` — list of sequences. Edit page: `/(app)/sequences/[id]/page.tsx`. Step editor with delayHours + template picker.
- `src/app/(app)/templates/page.tsx` — template library.
- `src/app/(app)/settings/comms/page.tsx` — "Connect Gmail" button (redirects to authorize). "Connect Outlook" button. "10DLC Status" indicator (reads Twilio Trust Hub via API OR a hardcoded flag until Ryan confirms). Reconnect buttons for expired tokens.

UI is not required for Gate 1 (the slice must boot standalone; UI can be minimal placeholders). Ryan will want inbox + sequence editor + settings usable at handoff — treat them as Milestone 4-5 parallel work.

## 12. The three acceptance gates

**Gate 1 — Runs in isolation.**

The slice boots on its own, connects only to its own tables, and responds to requests, with EVERY dependency mocked (from `contracts/mocks/`) and NO other agent's code present. The brief must specify the exact command that boots the slice standalone.

For Agent D specifically: the slice must start with `contracts/mocks/compliance/server.ts` running as a canned-fixture stand-in for Agent C, `contracts/mocks/twilio/server.ts` for Twilio Programmable Messaging, `contracts/mocks/gmail/server.ts` for Gmail API, and `contracts/mocks/graph/server.ts` for Microsoft Graph. Agents A, B, C code must be entirely absent from the running process (no imports).

**These four mocks are Agent D's responsibility to build** as part of Gate 1 setup. Each mock:
- HTTP server on a known port (env-driven).
- Responds to the contract-shaped requests defined in `contracts/http/`.
- Uses fixture JSON in `contracts/mocks/<vendor>/fixtures/`.
- Exposes `GET /_mock/health` returning 200.
- Exports Zod-validated response schemas so contract tests can assert conformance in both directions.
- Compliance mock endpoints:
  - `POST /scrub` — returns `{ results: [{ phone, callable, reasons: string[] }] }`. Reason values drawn from the working REASON_CODES enum (see §9).
  - `POST /dnc/internal` — returns the merged/locked shape `{ id, phone, source: "internal", addedAt, added: boolean }`. Test-mode flag `?legacy=1` returns the subset `{ id, phone, source, addedAt }` to exercise D's tolerant client wrapper.
  - `POST /callable-now` — returns `{ results: [{ contactPhoneId, phone, callable, reasons: string[], reasonDetails?: object }] }`. Enforces batch cap of 100 contactPhoneIds → HTTP 413 on exceed.
- Twilio mock endpoints: `POST /2010-04-01/Accounts/{sid}/Messages.json` (send), signature-check bypass flag for tests.
- Gmail mock endpoints: `users.threads.list`, `.get`, `.history.list`, `.messages.send`, `.watch`.
- Graph mock endpoints: `/me/mailFolders/inbox/messages/delta`, `/me/sendMail`.

**Exact isolation-boot command:**
```bash
cd worktrees/agent-d
pnpm run comms:isolated
```

Where `comms:isolated` in package.json chains: `pnpm run mocks:start` (starts the four mock servers on known ports) → `doppler run -- pnpm run dev` (starts Next.js pointing to mocks via env vars `COMPLIANCE_BASE_URL`, `TWILIO_MOCK_URL`, `GMAIL_MOCK_URL`, `GRAPH_MOCK_URL`).

Smoke test in isolation: hit `GET /api/comms/health` → 200. Hit `POST /api/comms/messages` with a mock email payload → routes to gmail-mock, returns messageId, status='sent'. Hit `POST /api/comms/webhook/sms` with a canned Twilio-signed inbound-STOP payload → verify the DNC path was invoked (HTTP POST to compliance mock's `/dnc/internal`, per B.1 HTTP-path resolution).

**Gate 2 — Honors the contract (BOTH DIRECTIONS).**

Slice passes the contract test suite (`contracts/tests/`) in both directions:
- Contract tests against the slice's OWN real service — proves it EMITS and ACCEPTS the frozen shapes:
  - Agent D's `message.received` NOTIFY payload matches the Zod schema in `contracts/events/message-received.ts` field-for-field, WITHOUT an `eventName` field and WITHOUT a `type` field.
  - `POST /api/comms/messages` request/response shapes match `contracts/http/comms-messages.ts`.
  - Consumption of `lead.upserted-from-import` tolerates both the canonical `{ leadId, sourceLabel, importBatchId, correlationId }` shape AND a drift shape with an extra `eventName`/`type` field (parses either without erroring).
- Contract tests against the MOCKS the slice consumes — proves those mocks are faithful, so when the mock is swapped for the real service at integration, it fits the same socket. Specifically:
  - The compliance mock's `POST /scrub` response must match the schema in `contracts/http/compliance-scrub.ts` (`{ results: [{ phone, callable, reasons: string[] }] }`), with reasons drawn from REASON_CODES.
  - The compliance mock's `POST /dnc/internal` response must match the merged/locked shape `{ id, phone, source, addedAt, added }`.
  - The compliance mock's `POST /callable-now` response must match `{ results: [{ contactPhoneId, phone, callable, reasons, reasonDetails? }] }` and enforces the 100-item batch cap.
  - Same for Twilio, Gmail, Graph.

Both directions must be green.

Run: `pnpm run test:contracts`.

**Gate 3 — Does its job.**

Behavioral acceptance tests specific to Agent D's purpose, plus a coverage floor of **85%** on critical paths.

Note on the 85% number: SHARED_CONTEXT §11 says CI enforces a coverage floor without specifying a number; other agent briefs may pick different numbers. If planner communicates a different threshold cross-agent, adopt it; otherwise 85% is the working target for this brief.

Critical paths (must have coverage ≥ 85% and dedicated acceptance tests):
1. **EmailThread reconstruction** from arbitrary Gmail message streams (forwards, replies, mixed participants, thread merges).
2. **Thread-to-contact reconciliation** — thread with null contactId, contact seeded, reconcile job → thread linked + messages linked. Includes payload-tolerance test for `lead.upserted-from-import` drift shape.
3. **Sequence tick logic** — step 1 delay 0h + step 2 delay 48h → step 2 fires ~48h after step 1 (fake-time integration test). Includes `Contact.timezone=null` fallback to `America/New_York`.
4. **Blackout date handling** — step due Saturday, blackoutDates=['<Saturday>'] → defer to Sunday (spec: next day not in blackoutDates); step due Saturday, blackoutDates=[Sat, Sun] → defer to Monday. DST-aware via luxon.
5. **SMS STOP → cross-service DNC path** via `POST /api/compliance/dnc/internal` → subsequent Message send to that phone rejected upstream (scrub returns callable=false with `reasons: ['internal_dnc']`). Includes tolerant-shape parsing test (legacy vs merged response).
6. **Sent-mail dedup** — CRM sets client-side Message-ID and providerMessageId in outbound send tx → inbound sync pulls same message → `createMany({skipDuplicates})` short-circuits → single Message row, direction='outgoing'.

Coverage measured via `vitest --coverage` on `src/lib/comms/{email,sequences,sms,dedup,templates}/**`. CI gate fails on <85% for any of those directories.

Run: `pnpm run test` (unit + acceptance) and `pnpm run test:coverage`.

**Enforcement:** each slice is its own package with its own test command and its own CI job. CI runs all 3 gates. NO slice enters integration RED.

## 13. Failure-mode behavior

Every external dependency: what happens when it fails.

| Dependency | Failure mode | Behavior |
|---|---|---|
| Gmail API (5xx / 429) | Delta sync request fails | pg-boss retries with exponential backoff (5 attempts over ~1h). If exhausted, mark `OAuthCredential.status='error'`, Sentry alert, log with correlationId. Never lose a message: last successful `historyId` is only updated on 2xx. |
| Gmail push (Pub/Sub) | Envelope malformed | Return 200 (avoid Pub/Sub exponential-backoff retry storm that stalls the account's push feed), log to Sentry, no state change. |
| Gmail refresh token invalid | 401 on refresh | Set `credential.status='reauth_required'`. UI shows "Reconnect Gmail" banner. Sync jobs skip this credential until reconnected. |
| Microsoft Graph | Same as Gmail semantics. Delta polling misses window → walks back via last valid deltaLink. |
| Twilio Messaging | 5xx on send | pg-boss retry with backoff. Final failure: `Message.status='error'` + `errorMessage`. Sentry alert. Do NOT silently drop. |
| Twilio webhook signature verification | Fails | 401. Do not process. Log to Sentry with `x-twilio-signature` header value for debugging. |
| Compliance `/api/compliance/scrub` | Timeout/5xx | **FAIL-CLOSED.** Treat every phone as `callable:false` with `reasons: ['compliance_unavailable']`. SMS send returns 409 with that reason. |
| Compliance `/api/compliance/dnc/internal` | Timeout/5xx / unexpected shape | Enqueue retry via pg-boss `sms-stop-relay`; tolerant client wrapper still succeeds if response is a subset shape. Never give up; escalate to Sentry critical after 24h. |
| pg-boss queue | DB connection loss | pg-boss reconnects automatically. Jobs persist in `pgboss.job` table. On restart, pending jobs resume. Health check surfaces queue depth. |
| Sequence step render error | Merge field lookup throws | Mark enrollment `status='error'`, log to Sentry, do NOT send garbled email. Ryan can investigate + resume/cancel. |
| OAUTH_TOKEN_ENCRYPTION_KEY missing/wrong | Decrypt fails | Refuse to boot (Gate 1 boot check). Sentry alert. Never fall back to plaintext. |
| Sent-mail dedup | `createMany({skipDuplicates:true})` handles inbound duplicates via unique constraint on `providerMessageId`. No delete-and-swap. P2002 during inbound insert should never occur in happy path; if it does, log Sentry and skip the insert. |
| Outlook re-auth needed | Refresh token revoked | Set `credential.status='reauth_required'`. UI banner. |
| `crm_lead_sync` LISTEN connection dropped | Postgres restart | Reconnect on boot; hourly cron `reconcile-threads` covers missed events. |
| `lead.upserted-from-import` payload contains drift discriminant | Zod parse would fail on strict mode | LISTENer strips `eventName`/`type` before validation. Log at info level; do not error. |

## 14. Contract change protocol

If you discover a frozen contract is wrong: **STOP. Do not work around locally. Message the planner (Ryan).** The planner updates `dealflow-crm/CONTRACTS.md` + contract-test schemas + notifies all agents to re-pull. Never silently patch a mismatch — that's how 4-agent parallelism collapses.

Specifically for Agent D, the planner-owned questions in Blocking Issues §B (OAuthCredential addition, Message.status enum treatment, `dnc/internal` response shape lock) MUST be resolved BEFORE the milestone that depends on them begins. Additional cross-brief items surfaced by the consistency review that the planner still owns:

- **Event-payload discriminant.** Lock: no `eventName`/`type` field in any event payload. This brief's `message.received` emitter complies; brief tolerates drift on `lead.upserted-from-import` consumption.
- **REASON_CODES enum.** Planner should publish a central enum for compliance `reasons[]` vocabulary. This brief uses the working set (`internal_dnc`, `federal_dnc`, `state_dnc`, `litigator`, `outside_calling_window_hour`, `outside_calling_window_day`, `holiday_suppressed`, `timezone_unresolved`, `mobile_line_unverified`, `compliance_unavailable`); additions route through §14.
- **`callable-now` response shape.** Locked (per critique) at `{ results: [{ contactPhoneId, phone, callable, reasons, reasonDetails? }] }` with 100-item batch cap. D's mock enforces both; D does not currently consume this endpoint from send paths.
- **`dnc/internal` response shape.** Locked at merged `{ id, phone, source, addedAt, added: boolean }`. D's client wrapper tolerates legacy subset shape for graceful degradation.
- **`crm_lead_sync` consumers.** SHARED_CONTEXT §5 to add D as documented consumer of `lead.upserted-from-import`.
- **Timezone fallback semantics.** Split resolution (per critique G2): fail-closed inside the compliance service (C never fabricates a timezone); fallback allowed at the display/scheduling layer (D uses `America/New_York` for sequence-tick math only). Confirm this split with planner before scaling multi-tenant.
- Does Agent A subscribe to `message.received` and update `ContactPhone.outboundSmsBlocked` from Agent C's `scrub.completed`? Agent D's answer: not our problem. We do not read that field; we scrub-inline.

## 15. Ryan's preferences (relevant subset)

- Always type deliverables in chat as full copyable text. When you finish a milestone, dump the entire commit as chat text for Ryan.
- `import 'dotenv/config'` MUST be the first import of any script in `scripts/` that touches DB.
- Run `npx prisma generate` between `pnpm prisma migrate dev` and any `tsc` / `vitest` run.
- iCloud landmine: check `find src -name "* 2.ts" -o -name "* 2.tsx"` before every grep-based audit and delete duplicates.
- Prisma sequential `.create()` against Railway ≈ 90ms/row. Use `createMany({ skipDuplicates: true })` for bulk writes >100 rows.
- Ship-when-tested. Gates green = ship. Do not gate on extra approvals.
- Minimum-viable-fix. Do not ladder up.
- Prefer stronger model. If you add any LLM call (you probably shouldn't in this slice), use Claude Sonnet 4.6, not gpt-4o-mini.
- Do not rely on Outlook auto-refresh for THIS CRM's OAuth. Plan for manual "Reconnect Outlook" UX. The refresh-token flow should work because this is a fresh consumer/multi-tenant OAuth app (unlike DealFlow's Elliman-tenant-blocked flow), but expose the button anyway.

## 16. Handoff / integration prep

When you hand off to integration, the slice should be in this state:

**Code state:**
- `main`-ready branch `agent-d`, all commits atomic + descriptive.
- CI green: Gate 1 (isolation boot), Gate 2 (contracts bidirectional), Gate 3 (behavior + coverage ≥85%).
- Coverage report checked in (or artifact-published).
- `src/lib/comms/` fully populated per §5 layout.
- Prisma migrations committed: `comms-oauth-credentials` (adds OAuthCredential, contingent on planner bless of Blocking Issue B.2). No `comms-init` migration — the six Agent-D-owned tables already exist in the shared schema.
- pg-boss migrations auto-run on boot.

**Documentation state:**
- `src/lib/comms/README.md` — one page: how the slice works, how to run isolated, how to run in dev with real credentials, how to trigger cron endpoints manually (`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sequences-tick`), how to verify sequences firing.
- `docs/10dlc-status.md` — current 10DLC Brand + Campaign SIDs, submission date, approval date, sample messages filed.
- `.env.example` updated with all new vars.

**Runtime state (in staging):**
- Ryan's Gmail connected (or a test address).
- Ryan's Outlook connected (or a test address).
- 10DLC live, Twilio Messaging Service SID configured.
- At least one MessageTemplate seeded (e.g., "Coming-soon listing outreach").
- At least one Sequence seeded (e.g., 3-step warm buyer sequence: email → email → SMS).
- pg-boss workers running as a Railway service (separate from Next.js web).
- Cron schedules configured externally (Vercel Cron or Railway cron): gmail-sync every 5min, graph-sync every 5min, sequences-tick every 15min, reconcile-threads every 60min.

**Known-open items for integration:**
- Confirm `/api/compliance/dnc/internal` response shape from Agent C's real service matches the merged/locked shape `{ id, phone, source, addedAt, added }` (or is at least a subset the D wrapper tolerates). Contract test in `contracts/tests/comms-to-compliance.test.ts` should pass against Agent C's real service (not just the mock).
- Confirm `message.received` NOTIFY payload matches what Agent A's activity projector expects (no `eventName` field, no `type` discriminant). Contract test in `contracts/tests/comms-emits.test.ts`.
- Confirm A's `lead.upserted-from-import` emitter shape at integration; D's consumer tolerates either shape, so nothing should break either way.
- Confirm C's `/api/compliance/scrub` reasons vocabulary matches the working REASON_CODES enum used in D's mocks.
- Confirm the SSE bridge sees `message.received` and forwards to the browser inbox page correctly. Manual smoke.
- **If the 10DLC clock ran out and campaign didn't approve in time:** integration ships email-only. SMS lands in a follow-on. Handoff message notes `10DLC: PENDING` in that case (see draft below).
- Confirm Agent A subscribes to `message.received` and appends Activity rows. Not our responsibility to enforce, but verify at integration.

**Handoff message to planner (draft — dump when done):**
> Agent D done. Isolation boot green, contracts bidirectional green, Gate 3 coverage at N% on critical paths. Gmail + Graph sync live in staging against my test accounts. 10DLC status: [SUBMITTED | APPROVED | PENDING — if PENDING, integration ships email-only per §16 known-open item]. Sequences tick every 15min. `message.received` NOTIFY verified (no eventName, no type discriminant, per SHARED_CONTEXT §5). Reconcile-threads cron running hourly; consumer tolerates `lead.upserted-from-import` drift shapes. STOP flow uses HTTP `/api/compliance/dnc/internal` per B.1 resolution; tolerant client wrapper handles merged and legacy response shapes. Reconcile-threads cron running hourly. Blocking issues B.2 (OAuthCredential) / B.3 (Message.status enum) resolved by planner as: [record actual resolutions]. Cross-brief planner locks (REASON_CODES, dnc/internal shape, callable-now shape, timezone fallback split, discriminant-free payloads) all landed. Ready to integrate.