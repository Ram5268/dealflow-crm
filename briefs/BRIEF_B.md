# Agent B Executor Brief — Telephony & Dial Engine

## Executive Summary

You are building the telephony slice of **dealflow-crm**: a WebRTC softphone (Twilio Voice JS SDK) + a multi-line power/predictive dial engine with an adaptive pacing control loop that keeps the operator under the FTC's 3%-over-30-days abandonment ceiling. This slice owns dial sessions, calls, call legs, and pacing metrics; it consumes a ranked queue from Agent A, checks compliance inline before every dial with Agent C (fail-closed), and emits `call.connected` / `call.completed` events that Agent A projects into activities and the browser SSE bridge pushes to the operator's ammunition panel. This is the highest-risk slice in the system — the pacing math and the two-legs-answer race resolver MUST be built and proven FIRST, before any Twilio integration.

**Vocabulary note for cold readers:** "ammunition panel" = the ranked-signal summary Agent A produces from DealFlow's Match table (priorityScore, topMatchFit, captureStatus, matchReason, deep link back to DealFlow); it renders as a right-side pane during a live call and is the whole point of the softphone.

---

## 1. Project Context (Cold-Reader Onboarding)

**Who Ryan is:** Ryan Martin, a solo NYC Douglas Elliman real-estate broker. Non-engineer. Single-operator. One seat. Everything you build serves ONE user, but every table has an `organizationId` column because Ryan wants the multi-seat seam preserved.

**What DealFlow is:** `dealflow-inbox-intelligence` is the sibling app that already exists in a separate repo. It reads Ryan's Outlook inbox via Microsoft Graph (READ-ONLY), classifies emails into real-estate categories, extracts BUYER_ISO / listing opportunities into a `ExtractedOpportunity` table, runs a matcher that pairs sellers with buyers into `Match` rows, and runs a nightly ranker (Brief 33) that produces `CallQueueEntry` rows — the prioritized list of who Ryan should call today. DealFlow stays running. It is NOT being replaced. The new CRM you're building consumes DealFlow's signals via a read-only Postgres role.

**What dealflow-crm is:** a greenfield sibling repo that replaces Ryan's dependency on Mojo Dialer + Mojo CRM. It provides a property-centric CRM database, a WebRTC softphone, a power/predictive dialer, consumer-calling compliance (federal + state DNC, litigator scrub, mobile-line ID, timezone windows, holiday suppression), two-way email + SMS sync, sequences, and an AI-driven CSV importer.

**Greenfield decision:** Twenty / Atomic CRM / ICTCRM were all evaluated and rejected in Phase −1 spike. Reasons: real-time paradigm mismatch, AGPL contamination risk, stack impedance with DealFlow, CRUD shape doesn't fit softphone. We are building this from scratch.

**Sibling repo, not monorepo:** `dealflow-crm/` lives on disk next to `dealflow-inbox-intelligence/`. Independent deploy. Same Railway Postgres server, DIFFERENT logical DB (`dealflow_crm`).

**Four-agent parallelism:** The CRM is being built by four executors working in parallel git worktrees, each owning a "slice." You are Agent B — telephony. Agent A owns core data (Lead/Contact/Opportunity/Import). Agent C owns compliance (DNC/litigator/windows). Agent D owns communications (email/SMS/sequences). You will never see their briefs and they will never see yours. The contracts between you are frozen in `contracts/` — LISTEN/NOTIFY event payloads (Zod schemas) and HTTP endpoint shapes. **If you discover a frozen contract is wrong: STOP. Message Ryan. Do not silently patch — that's how 4-agent parallelism collapses.**

---

## 2. BLOCKING ISSUES — READ FIRST

These do not stop Milestones 1a/1b (do those regardless). They DO block later milestones and integration:

1. **DNC vendor selection is TBD.** Agent C owns the vendor call. You depend on Agent C's `POST /api/compliance/callable-now` endpoint at dial time. During Milestones 1–3 you MUST use the mock service at `contracts/mocks/compliance/` — do not stub inline in your code. When Ryan finalizes the vendor, you swap the mock URL for the real URL. No code changes required.
2. **Twilio phone number / caller ID (`TWILIO_CALLER_ID_NUMBER`).** Must be a Twilio-owned or verified number for outbound dialing. Ryan must provision this before Milestone 2 real-Twilio work. Test credentials work fine for Milestone 2's smoke tests.
3. **10DLC brand + campaign registration.** Not your problem (Agent D owns messaging), but if Ryan hasn't finished carrier registration by Milestone 2, some Twilio Voice features may share rate limits with messaging — check with Ryan before pushing high-volume dialing.
4. **`TWILIO_MONTHLY_SPEND_CAP_USD`** must be set in Doppler before Milestone 5. Default to $200 in `.env.example` (this is a soft rail, NOT a zero-cost default — Ryan chose $200 as the belt-and-suspenders backstop; flag if he wants it lower).
5. **Race-resolver loser message — Ryan-decision blocker.** The TwiML string for the dropped-loser leg is NOT in shared context. Proposed default text (see §10 Milestone 1b) is placeholder ONLY — Ryan must approve verbatim (or record an MP3) before the string is baked in. Track it as a §13 planner request when you hit Milestone 1b.
6. **Schema drift proposals (route via §13 planner, do NOT self-apply):**
   - Adding `@@unique` idempotency guarantee on `CallLeg.providerLegSid` (preferred form: composite `@@unique([callId, providerLegSid])`).
   - `Call.source` default currently reads `"Close.io"` — copy-pasted from Close's OpenAPI reference; must change to `"dealflow-crm"`.
   - `Call.status` enum lists `'cancel'`; Twilio emits `'canceled'` — must reconcile (either widen enum or add explicit mapping).
   - `Call.emittedAt DateTime?` for lost-emission recovery (see §7.3).
   Do NOT edit `prisma/schema.prisma` for any of these until the planner responds. See §6 and §13.
7. **72-hour dropped-loser exclusion locus (planner decision).** Whether Agent A's queue endpoint filters this, or Agent B skips locally, is a real contract decision. Interim behavior is defined in §4 (Agent B skips locally, single owner), but the planner may reassign — flag when you hit Milestone 4.
8. **Cross-brief inconsistencies flagged by the consistency critic — planner-locked as of this brief revision (see §8.3 for the full lock list):** the queue response uses `primaryPhoneE164` (not `primaryPhone`); the callable-now response includes BOTH `contactPhoneId` AND `phone`; `reasons[]` is drawn from a frozen `REASON_CODES` enum; event payloads use a `type` discriminant field (no `eventName`); `cost` on `call.completed` is a decimal-as-string. Confirm the shared schemas in `contracts/events/` and `contracts/http/` reflect these locks before writing your consumer schemas.

---

## 3. What This Slice Owns

**Prisma tables (WRITE):**
- `DialSession`
- `Call`
- `CallLeg`
- `PacingMetric`

You may READ any table in the DB. You may NOT WRITE to any table outside the four above.

**HTTP endpoints exposed:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/telephony/dial-sessions` | Create a new dial session |
| PATCH | `/api/telephony/dial-sessions/:id` | Pause / end / adjust `maxLineCount` |
| GET | `/api/telephony/dial-sessions/:id` | Session status |
| POST | `/api/telephony/calls/token` | Twilio Voice SDK short-lived JWT for browser softphone |
| POST | `/api/telephony/webhook/voice` | TwiML answer with AMD result |
| POST | `/api/telephony/webhook/status` | Twilio call-progress events |
| POST | `/api/telephony/webhook/recording` | Twilio recording-status callback |
| GET | `/api/telephony/pacing/status` | Current lineCount + abandonment30d for a session |
| POST | `/api/telephony/pacing/resume` | Bearer-authed (CRON_SECRET) un-halt after circuit breaker |
| GET | `/api/telephony/calls/:id/ammunition` | Server-hydrate ammunition panel data |
| GET | `/api/telephony/calls/:id/recording` | 302-redirect to presigned R2 URL |
| GET | `/api/telephony/health` | Health check |

**Events emitted (LISTEN/NOTIFY channel `crm_call`):**
- `call.connected` → `{ type: "call.connected", callId, dialSessionId, leadId, contactId, remotePhone, connectedAt, correlationId }`
- `call.completed` → `{ type: "call.completed", callId, disposition, duration, cost, outcomeId?, correlationId }`
- `dial-session.pacing-update` → `{ type: "dial-session.pacing-update", dialSessionId, currentLineCount, abandonment30d, correlationId }` (every 60s from pacing worker)

**Discriminant convention:** every event payload on `crm_call` includes a `type: string` literal field per the planner-locked convention (§8.3, item 4). No `eventName` field. Downstream consumers dispatch on `type`.

**Events consumed:** none. You are source-side.

**Cross-slice HTTP consumed:**
- `GET /api/queue?viewId=<save_...>&limit=50` — Agent A. Fetches the ranked, pre-scrubbed lead list.
- `POST /api/compliance/callable-now` — Agent C. Called INLINE before every dial with fail-closed handling.

---

## 4. What This Slice Does NOT Touch

Do NOT write to any of these:
- **Agent A tables:** Lead, Contact, ContactPhone, ContactEmail, ContactUrl, Opportunity, Task, Activity, CustomFieldDefinition, CustomFieldValue, SavedView, CustomActivityType, Attachment, ImportBatch, DealFlowDerivedSignal. In particular you do NOT write the `Activity` row on `call.connected` — you EMIT the event; Agent A's activity projector consumes it and writes the Activity row.
- **Agent C tables:** DncSuppression, LitigatorSuppression, MobileLineCache, CallingWindowConfig, HolidaySuppressionDate, ScrubLog.
- **Agent D tables:** Message, EmailThread, MessageTemplate, Sequence, SequenceStep, SequenceEnrollment.

Do NOT call any HTTP endpoint on other slices beyond the two named in §3 (`/api/queue` and `/api/compliance/callable-now`).

### 4.1 The 72-hour dropped-loser dial-exclusion — SINGLE OWNER

Agent B skips locally. Full stop. Rationale + protocol:

- **Owner:** Agent B (this slice).
- **Mechanism:** `nextContact()` in `src/lib/telephony/dial-loop/nextContact.ts` filters out any `contactPhoneId` whose most recent `CallLeg` row (which is Agent B's table — a self-read) has `disposition='dropped-loser'` AND `droppedLoserMessage=true` AND `startedAt >= now() - interval '72 hours'`.
- **Agent A's `/api/queue` does NOT know about this exclusion.** Agent A returns the ranked list; Agent B is the last line before dial and applies the filter.
- **Why single-owner:** the exclusion depends on a state that lives entirely inside Agent B's tables. A cross-schema JOIN in Agent A's endpoint would create silent contract drift and violate ownership. If the planner later decides Agent A should apply it (e.g. for consistency across dial paths), that's a §13 planner change, not an executor decision.
- **Protocol action when you reach Milestone 4:** file a §13 request to Ryan of the form: "Milestone 4 landed with Agent B filtering dropped-loser locally. Confirm this is the intended locus, or flag for Agent A to co-implement." Do NOT block on the response — ship Milestone 4 with the local filter; if Ryan flips it, remove the local filter later.

If you find yourself needing to write a `Task` row for a different reason (e.g. a follow-up task on an answered call): DO NOT. Emit a domain event on `crm_call` with a payload Agent A can pick up, OR message Ryan to add an Agent A endpoint. Never touch Agent A's tables directly.

---

## 5. Environment / Secrets

All secrets are injected via **Doppler** at runtime. Never commit real secrets. Repo has `.env.example` only. Every script and route uses Doppler CLI in dev: `doppler run -- pnpm dev`.

**Every slice needs:**
- `DATABASE_URL_MAIN` — Railway Postgres for `dealflow_crm` logical DB
- `CRON_SECRET` — bearer for cron/system endpoints (e.g. pacing resume)
- `SENTRY_DSN`
- `SENTRY_ENVIRONMENT`

**Agent B additionally needs:**
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_APP_SID` — TwiML App SID that points Twilio at your voice webhook base
- `TWILIO_API_KEY_SID` — for signing Voice SDK JWTs
- `TWILIO_API_KEY_SECRET` — for signing Voice SDK JWTs
- `TWILIO_CALLER_ID_NUMBER` — E.164 outbound number (**BLOCKING — Ryan must provision**)
- `TWILIO_VOICE_WEBHOOK_BASE` — public URL prefix (e.g. `https://crm.dealflow.com/api/telephony/webhook`)
- `TWILIO_RECORDING_STATUS_CALLBACK` — full URL for recording callback
- `TWILIO_MONTHLY_SPEND_CAP_USD` — integer USD cap (default 200 in `.env.example`, soft rail)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_RECORDINGS` — Cloudflare R2 for recording storage
- `COMPLIANCE_SERVICE_BASE_URL` — set to the local mock at `http://localhost:4102` during Milestones 1–3; swap to Agent C's real URL at integration
- `QUEUE_SERVICE_BASE_URL` — set to the local mock at `http://localhost:4101` during Milestones 1–3; swap to Agent A's real URL at integration
- `PACING_INTERVAL_SECONDS` — default 60
- `RING_TIMEOUT_SECONDS` — default 19
- `RACE_LOSER_TWIML_MODE` — `say` | `play`; default `say` until Ryan approves an MP3
- `RACE_LOSER_TWIML_TEXT` — string; default `"Sorry, our agent just stepped away. We'll call you back shortly."` (**Ryan-decision blocker — placeholder only**)
- `RACE_LOSER_TWIML_MP3_URL` — R2 URL for the pre-recorded loser message when `RACE_LOSER_TWIML_MODE=play`

Add all of these to `.env.example` with placeholder values and comments.

---

## 6. Complete Prisma Schema — Tables This Slice Owns

Copy VERBATIM into `prisma/schema.prisma` alongside tables the other agents own. **DO NOT PARAPHRASE. DO NOT MODIFY.** These are frozen. See §6.1 for schema-drift proposals that require planner approval BEFORE you edit.

```prisma
model DialSession {
  id String @id @default(dbgenerated("'dial_' || substr(md5(random()::text), 1, 24)"))
  organizationId String
  userId String
  sourceType String        // saved-search
  sourceValue String       // SavedView.id
  method String            // power|predictive
  lineCount Int @default(1)
  maxLineCount Int @default(3)
  status String @default("active")
  callerId String          // E.164
  ringTimeoutSec Int @default(19)  // Close's "Reduced Ring Time"; FTC floor is 15
  startedAt DateTime @default(now())
  endedAt DateTime?
  organization Organization @relation(fields: [organizationId], references: [id])
  user User @relation(fields: [userId], references: [id])
  calls Call[]
  @@index([organizationId, startedAt(sort: Desc)])
}

model Call {
  id String @id @default(dbgenerated("'call_' || substr(md5(random()::text), 1, 24)"))
  organizationId String
  userId String?
  leadId String?
  contactId String?
  dialSessionId String?
  direction String         // inbound|outbound
  callMethod String        // regular|power|predictive
  disposition String?      // answered|vm-answer|vm-left|busy|blocked|error|abandoned
  status String @default("created")  // created|in-progress|completed|cancel|no-answer|busy|failed|timeout
  source String @default("Close.io")
  localPhone String
  remotePhone String
  duration Int?
  cost Decimal? @db.Decimal(10, 4)
  providerCallSid String @unique
  providerStatusCallback String?
  recordingUrl String?     // R2 key
  recordingDurationSec Int?
  voicemailUrl String?
  voicemailDurationSec Int?
  outcomeId String?
  noteHtml String?
  activityAt DateTime @default(now())
  dateCreated DateTime @default(now())
  dialSession DialSession? @relation(fields: [dialSessionId], references: [id], onDelete: SetNull)
  user User? @relation(fields: [userId], references: [id])
  legs CallLeg[]
  @@index([organizationId, activityAt(sort: Desc)])
  @@index([dialSessionId])
  @@index([providerCallSid])
}

model CallLeg {
  id String @id @default(cuid())
  callId String
  contactPhoneId String
  providerLegSid String
  startedAt DateTime @default(now())
  connectedAt DateTime?
  endedAt DateTime?
  amdResult String?        // machine|human|unknown
  amdConfidence Float?
  disposition String?      // won|dropped-loser|no-answer|busy|error
  droppedLoserMessage Boolean @default(false)
  call Call @relation(fields: [callId], references: [id], onDelete: Cascade)
  @@index([callId])
  @@index([providerLegSid])
}

model PacingMetric {
  id String @id @default(cuid())
  organizationId String
  dialSessionId String?
  minuteBucket DateTime    // truncated to minute UTC
  dialsInitiated Int @default(0)
  humansReached Int @default(0)
  amdMachineHang Int @default(0)
  abandonedCalls Int @default(0)
  amdFalsePositive Int @default(0)
  currentLineCount Int?    // control-loop state at time of write
  @@index([organizationId, minuteBucket(sort: Desc)])
  @@index([dialSessionId, minuteBucket(sort: Desc)])
}
```

**One-time gotcha:** the parent tables (`Organization`, `User`) are owned by Agent A. You need them defined for foreign keys to compile, but Agent A owns their WRITES. Rely on the `prisma/schema.prisma` that's already in `main` (or in your worktree after `git pull`) — do not redefine them.

### 6.1 Schema-drift proposals — DO NOT self-apply

These are known issues with the frozen schema. Each one is a §13 planner request. Do NOT edit `prisma/schema.prisma` until Ryan responds; file the request when you hit the relevant milestone.

1. **Idempotency guarantee on `CallLeg`.** Webhook replay-safety for the AMD callback keys on the `providerLegSid`. Preferred form is a composite `@@unique([callId, providerLegSid])` (semantically safer than `providerLegSid` alone — the same SID theoretically could recur across accounts under exotic Twilio failure modes, and the composite protects against phantom cross-call collisions). File at start of Milestone 2. Until the planner responds, achieve idempotency in application code: SELECT-then-INSERT inside the same transaction, keyed on `(callId, providerLegSid)`.
2. **`Call.source` default is `"Close.io"`** — copy-pasted from Close's OpenAPI reference. Must change to `"dealflow-crm"`. File at start of Milestone 2. Until the planner responds, override the default at insert time by explicitly passing `source: "dealflow-crm"` in every `Call` insert path.
3. **`Call.status` enum lists `'cancel'`; Twilio emits `'canceled'`.** File at start of Milestone 2. Until the planner responds, add an explicit mapping in your Twilio status webhook handler: `'canceled' -> 'cancel'`. Log the mapping via pino at info level so we can audit.
4. **`Call.emittedAt DateTime?`** for lost-emission recovery — see §7.3. File at start of Milestone 5. Until the planner responds, use the in-memory sentinel-table workaround in §7.3.

---

## 7. Event Catalog

### 7.1 Events you EMIT

All emissions go through Postgres `LISTEN/NOTIFY` on channel `crm_call`. Emit in the **same transaction** as the state change. Payload is JSON with a `type` discriminant and a `correlationId` (uuid v4). Per the planner lock (§8.3, item 4), the discriminant field is `type` and NO `eventName` field appears.

```typescript
// contracts/events/call.connected.ts
export const CallConnectedEvent = z.object({
  type: z.literal("call.connected"),
  callId: z.string(),
  dialSessionId: z.string(),
  leadId: z.string().nullable(),
  contactId: z.string().nullable(),
  remotePhone: z.string(),         // E.164
  connectedAt: z.string(),         // ISO8601 UTC
  correlationId: z.string().uuid(),
});

// contracts/events/call.completed.ts
// NOTE: `cost` is a DECIMAL-AS-STRING on the wire — Prisma Decimal
// serializes as string. Agent A's activity projector accepts it as string,
// per the planner lock (§8.3, item 2). Do NOT coerce to number here.
export const CallCompletedEvent = z.object({
  type: z.literal("call.completed"),
  callId: z.string(),
  disposition: z.enum([
    "answered", "vm-answer", "vm-left", "busy",
    "blocked", "error", "abandoned"
  ]),
  duration: z.number().int().nullable(),  // seconds
  cost: z.string().nullable(),            // decimal-as-string (see note above)
  outcomeId: z.string().nullable().optional(),
  correlationId: z.string().uuid(),
});

// contracts/events/dial-session.pacing-update.ts
export const PacingUpdateEvent = z.object({
  type: z.literal("dial-session.pacing-update"),
  dialSessionId: z.string(),
  currentLineCount: z.number().int(),
  abandonment30d: z.number(),      // fraction, 0.0–1.0
  correlationId: z.string().uuid(),
});
```

**Consumer note for `dial-session.pacing-update`:** SHARED_CONTEXT names the consumer as "Ops dashboard." Agent A subscribes to `crm_call` but only dispatches on `call.connected` / `call.completed` — A ignores unknown `type` values. This is benign but expected; do not treat A's silence on this event as a bug.

### 7.2 Events you CONSUME

None. You are source-side for `crm_call`.

### 7.3 Emission mechanics + lost-emission recovery

Use a small helper in `src/lib/telephony/events/emit.ts`:

```typescript
export async function emitOnCallChannel(
  tx: Prisma.TransactionClient,
  payload: object
): Promise<void> {
  const json = JSON.stringify(payload);
  await tx.$executeRawUnsafe(`SELECT pg_notify('crm_call', $1)`, json);
}
```

`pg_notify` inside a transaction fires at COMMIT, so the emission is atomic with the state change. Good.

**Lost-emission recovery:** three scenarios where the emit is lost even though the state row was written OR should have been:

- **App crashes mid-tx.** Both the state write and the emit roll back. This is correct (no partial state). Nothing to recover.
- **Emit fires but no listener is attached** (e.g. SSE bridge is down when NOTIFY fires). Postgres does not queue LISTEN/NOTIFY across disconnected listeners.
- **State row committed pre-brief (e.g. reconciliation job discovers a terminal state in Twilio that we missed).** No emission was ever fired.

To cover the last two, **emissions ARE re-fired by the reconciliation loop AND by an emission-outbox check**:

- Add a small marker column `emittedAt DateTime?` to `Call` for `call.completed` semantics (this IS a schema-drift request — file it via §13 at start of Milestone 5).
- The reconciliation job (§10 Milestone 5) additionally scans `Call` where `status IN ('completed','no-answer','busy','failed','canceled') AND emittedAt IS NULL AND dateCreated < now() - interval '2 minutes'` and re-emits `call.completed` inside a tx that sets `emittedAt = now()`. Idempotent by the `emittedAt IS NULL` filter.
- Downstream consumers (Agent A activity projector) already require idempotency; a duplicate `call.completed` is a no-op for them.
- Until the schema-drift request lands, use an in-memory sentinel table `_CallEmissionOutbox(callId PRIMARY KEY, emittedAt)` created by a Prisma migration in your worktree that touches only your own tables — the outbox is Agent B's, so this is allowed.

For `call.connected`, the recovery path is less critical (a missed connected event just means a delayed ammunition panel; the operator is already on the call). Log to Sentry when the recon job detects a `Call` in `in-progress` older than 30 seconds without a corresponding `call.connected` emission trace, but do not auto-refire — the SSE window has passed.

Always call `emitOnCallChannel` inside a transaction that also writes the state change. Never emit outside a tx (double-emission if the tx rolls back is impossible with `pg_notify`, but the pattern discipline matters).

---

## 8. HTTP Contracts

### 8.1 Endpoints this slice EXPOSES

Every endpoint requires header `x-correlation-id` (middleware auto-generates if missing). Every response is JSON.

**POST `/api/telephony/dial-sessions`**
- Body: `{ viewId: string, method: "power"|"predictive", lineCount: number, maxLineCount?: number, callerId: string }`
- Response 201: `{ sessionId, startedAt }`
- Response 503 (circuit breaker halted): `{ error: "pacing_halted" | "spend_cap_reached", abandonmentPct?, monthlySpendUsd? }`
- Behavior: verify `viewId` exists by calling `GET /api/queue?viewId=<id>&limit=1` on Agent A. Insert `DialSession` row. Return.

**PATCH `/api/telephony/dial-sessions/:id`**
- Body (any subset): `{ status?: "active"|"paused"|"ended", maxLineCount?: number }`
- Response 200: updated session summary.
- Behavior: idempotent. Ending a session gracefully terminates in-flight legs.

**GET `/api/telephony/dial-sessions/:id`**
- Response: `{ id, status, method, lineCount, maxLineCount, startedAt, endedAt, callCounts: { total, answered, vmLeft, abandoned } }`

**POST `/api/telephony/calls/token`**
- Body: `{}` (userId derived from auth session)
- Response 200: `{ token, identity, expiresAt }` — Twilio Voice SDK JWT (TTL 1 hour, use Twilio's `AccessToken` + `VoiceGrant`).

**POST `/api/telephony/webhook/voice`**
- Twilio-signed. Validate signature with `twilio.validateRequest(authToken, signature, url, params)`. If invalid: 403.
- Body: Twilio form-encoded params (`CallSid`, `AnsweredBy`, `MachineDetectionDuration`, etc.)
- Response: TwiML XML. Behavior below in Milestone 2.

**POST `/api/telephony/webhook/status`**
- Twilio-signed. Idempotent on `CallSid`. Body: form-encoded call-progress params. Updates `Call.status`, `Call.duration`, `Call.cost`, `Call.disposition` as appropriate. Emits `call.completed` when status ∈ `{completed, no-answer, busy, failed, canceled}`. Map Twilio `canceled` → local `cancel` per §6.1.

**POST `/api/telephony/webhook/recording`**
- Twilio-signed. Body: `{ CallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus }`
- Behavior: fetch MP3 from `RecordingUrl` (append `.mp3`), PUT to R2 at `recordings/<callId>.mp3`, update `Call.recordingUrl`. On R2 failure: Sentry alert, retain Twilio URL for retry, do NOT fail the call.

**GET `/api/telephony/pacing/status?dialSessionId=<id>`**
- Response: `{ currentLineCount, abandonment30dPct, amdFalsePositive24hPct, halted: boolean, haltReason?: "abandonment" | "spend" }`

**POST `/api/telephony/pacing/resume`**
- Bearer `CRON_SECRET`. Body: `{}`. Response 200: `{ resumedAt }`. Behavior: clear halt flag, allow new dial sessions.

**GET `/api/telephony/calls/:id/ammunition`**
- Response: `{ lead: { id, displayName, priorityScore, topMatchFit, captureStatus, matchReason, dealflowDeepLink, primaryAddressSummary }, contact: { id, displayName, phones: [{ id, phone, phoneFormatted, type, lineType }] }, derivedSignal: { queueRank, queueReason, primaryMatchFit, primaryCaptureStatus, primaryMatchConfidence } | null }`
- Behavior: SELECT-only. Reads `Lead` and `DealFlowDerivedSignal` (both Agent A tables, read is allowed per SHARED_CONTEXT §4 "Agents CAN read any table"). Import Prisma types A owns; do not redefine models. Target p95 <100ms — the endpoint contributes to the <200ms ammunition-hydration budget (see §10 Milestone 3 for the budget's exact start-anchor).

**GET `/api/telephony/calls/:id/recording`**
- Response 302: redirect to a presigned R2 URL, TTL 300s. Never expose the R2 URL directly.
- Response 404 if `Call.recordingUrl` is null.

**GET `/api/telephony/health`**
- Response 200: `{ status: "ok", version, halted: boolean, haltReason?: string }`

### 8.2 Endpoints this slice CONSUMES

**GET `/api/queue?viewId=<save_...>&limit=50`** — Agent A. Per the planner lock (§8.3, items 5 and 6), the exposed shape is:

```typescript
{
  view: { id: string, name: string },
  leads: Array<{
    leadId: string,
    contactId: string,
    displayName: string,                    // added per planner lock (Coverage Gap #4)
    primaryPhoneId: string,
    primaryPhoneE164: string,               // renamed from `primaryPhone` per lock item 6
    timezone: string | null,                // A does NOT synthesize a fallback; may be null (see §8.3 item 8)
    ammunition: {
      priorityScore: number | null,
      topMatchFit: number | null,
      captureStatus: string | null,
      matchReason: string | null,
      dealflowDeepLink: string | null
    }
  }>,
  excludedNoPhone: number,                  // A-side telemetry; passthrough-parsed
  excludedCompliance: number,               // A-side telemetry; passthrough-parsed
  stale: boolean,                           // set if A's ranker last ran > threshold ago
  staleReason: string | null,               // human-readable
  generatedAt: string                       // ISO
}
```

**Zod schema note:** define your consumer schema with `.passthrough()` so A can add fields without breaking your parse. B does not use `excludedNoPhone`, `excludedCompliance`, `stale`, `staleReason`, or `displayName` at dial time — they're passthrough. If `stale === true`, log Sentry warning but proceed (the ranker being late is A's problem, not a reason for B to refuse to dial). If `timezone === null`, DO NOT synthesize a value; pass the `contactPhoneId` to Agent C and let C fail-closed on missing timezone (per the planner lock in §8.3 item 8).

**POST `/api/compliance/callable-now`** — Agent C. Per the planner lock (§8.3, items 6 and 7), request:

```typescript
// Batch cap: 100 contactPhoneIds. Requests with >100 return HTTP 413.
{ contactPhoneIds: string[] /* max 100 */, atInstant?: string /* ISO */ }
```

Response:

```typescript
{
  results: Array<{
    contactPhoneId: string,   // present per lock
    phone: string,            // present per lock (both A and B expect it)
    callable: boolean,
    reasons: string[],        // drawn from REASON_CODES enum (see §8.4)
    reasonDetails?: object    // C-only, optional passthrough
  }>
}
```

**Fail-closed:** on ANY error (timeout, 5xx, network) treat every phone as `callable:false`. NEVER dial without a positive-safe signal.

**Batch cap:** B's dial-loop only ever checks ONE `contactPhoneId` at a time (per-dial), so the 100 cap never bites at dial time. If B ever adds a batched pre-warm check (e.g. for UI preview), chunk into groups of 100.

**When to pass `atInstant`:** DO NOT pass it at dial time. Omitting `atInstant` means Agent C evaluates against wall-clock-now, which is exactly what you want. The check is authoritative at the moment of the dial-loop iteration. **Calling-window enforcement is Agent C's fail-closed responsibility** — Agent B does not second-guess and does not re-check per-leg during an in-flight session. A session that started at 7:55pm ET and rolls a new dial at 8:01pm ET will get a fresh `callable:false` from Agent C at that moment; that's the design. **Do not** cache callable-now results across dial-loop iterations.

**Reason vocabulary:** `reasons[]` values are drawn from a frozen `REASON_CODES` enum published centrally (see §8.4). Log unknown values via Sentry — they indicate C added a code without ratifying it, which is a §13 contract-change event.

### 8.3 Planner-locked wire-shape decisions (post-critic pass)

These locks resolve the cross-brief inconsistencies flagged by the consistency critic. They MUST match `contracts/events/`, `contracts/http/`, and the mocks under `contracts/mocks/`. If any of them drift after this brief's issuance, that is a §13 event.

1. **Event payload discriminant:** the field is `type` (string literal). No `eventName` field. Applies to all channels (`crm_call`, `crm_message`, `crm_scrub`, `crm_lead_sync`). Consumers dispatch on `type`.
2. **`call.completed.cost` wire type:** decimal-as-string, `z.string().nullable()`. Prisma Decimal serialization convention. Consumers must NOT expect `number`.
3. **`scrub.completed` payload:** `{ type: "scrub.completed", phoneCount, blockedCount, checkedAt, correlationId }`. B does not consume this event; noted for completeness.
4. **`dial-session.pacing-update`:** consumed by the Ops dashboard (post-MVP). Agent A subscribes to the channel but ignores unknown `type` values — this is expected and not a bug.
5. **Queue response `displayName`:** field is present on every lead entry (A-side, used for UI). Passthrough for B.
6. **Queue response `primaryPhoneE164`:** renamed from `primaryPhone` per critic item 3. E.164 formatted.
7. **`callable-now` response includes BOTH `contactPhoneId` and `phone`:** per critic item 7. A and B both expect `phone`; C returns it. `reasonDetails` is optional passthrough.
8. **Timezone fallback semantics:** A DOES NOT synthesize `America/New_York` when `Contact.timezone` is null. A returns `timezone: null`. C fails-closed on missing timezone (returns `callable: false` with `reasons: ["timezone_unresolved"]`). B does not attempt to substitute a default before calling C. Result: leads with no timezone flow through the queue but never dial — visible via Sentry `compliance_blocked` logs with reason `timezone_unresolved`. Rationale: fail-closed everywhere. Display-layer fallback (rendering "ET" in the UI) is fine because it is not part of the compliance decision.
9. **`Lead.source = "import:" + importBatchId`** for AI-importer batches — planner-ratified A-side commitment. Not directly relevant to B, but if B reads `Lead.source` for telemetry (e.g. call ammunition), expect this format.

### 8.4 `REASON_CODES` enum (frozen, planner-published)

The vocabulary for `callable-now` `reasons[]` and `ScrubLog.result` where applicable. This is the version at brief issuance; treat as frozen. Any new value from C is a §13 contract change.

```typescript
export const REASON_CODES = [
  "internal_dnc",
  "federal_dnc",
  "state_dnc",
  "litigator",
  "outside_calling_window_hour",
  "outside_calling_window_day",
  "holiday_suppression",
  "mobile_line_blocked",
  "timezone_unresolved",
  "phone_missing",
  "phone_invalid",
  "unsubscribed",
  "vendor_error",           // C-side vendor failure → fail-closed
  "internal_error",         // any other fail-closed
] as const;
export type ReasonCode = typeof REASON_CODES[number];
```

Consumer schema for the callable-now response uses `z.enum(REASON_CODES)` for each entry in `reasons[]`, and logs a Sentry warning if C returns anything outside the enum (this indicates unratified C-side drift). Fail-closed still applies — if the whole response is malformed, treat all phones as `callable:false`.

---

## 9. Repository Layout + Worktree Setup

The parent repo `dealflow-crm` is already scaffolded on main. It contains the app shell, the frozen Prisma schema, `CONTRACTS.md`, and `contracts/`.

**One-time setup (from `dealflow-crm/` root):**

```bash
cd /Users/Ram5268/Library/Mobile\ Documents/com~apple~CloudDocs/Antigravity\ Projects/dealflow-crm

# Fetch and create worktree
git fetch origin
git worktree add worktrees/agent-telephony -b agent-telephony origin/main
cd worktrees/agent-telephony

# Install
pnpm install
cp .env.example .env  # populate via Doppler in real runs

# Prisma
doppler run -- pnpm prisma generate

# Verify boot
doppler run -- pnpm dev
```

**Do NOT share HEAD with other executors.** Each agent has its own worktree. Pull contract changes with `git pull origin main` in your worktree only.

**Slice-owned code lives under:**
```
src/lib/telephony/
├── pacing/
│   ├── computeNewLineCount.ts       # Milestone 1a — pure function
│   ├── worker.ts                    # 60s loop
│   └── metrics.ts                   # PacingMetric write helpers
├── race-resolver/
│   ├── acquireWinner.ts             # Milestone 1b — advisory lock helper
│   └── droppedLoser.ts              # TwiML + CallLeg update
├── twilio/
│   ├── client.ts                    # Twilio SDK singleton
│   ├── signature.ts                 # webhook validation
│   ├── amd.ts                       # AMD result parsing
│   ├── statusMap.ts                 # Twilio status -> local enum (see §6.1)
│   └── recording.ts                 # R2 upload
├── dial-loop/
│   ├── session.ts                   # session state machine
│   ├── nextContact.ts               # pull from Agent A queue + local dropped-loser filter
│   └── placeCall.ts                 # inline compliance + Twilio.calls.create
├── reconciliation/
│   └── job.ts                       # 5min recon loop + emission-outbox
├── events/
│   └── emit.ts                      # pg_notify wrapper
├── cost/
│   └── monthlyCap.ts                # rolling sum + halt
├── reason-codes.ts                  # REASON_CODES enum (import from contracts/)
└── ammunition/
    └── hydrate.ts                   # server-side data pull

src/app/api/telephony/
├── dial-sessions/route.ts
├── dial-sessions/[id]/route.ts
├── calls/token/route.ts
├── calls/[id]/ammunition/route.ts
├── calls/[id]/recording/route.ts
├── webhook/voice/route.ts
├── webhook/status/route.ts
├── webhook/recording/route.ts
├── pacing/status/route.ts
├── pacing/resume/route.ts
└── health/route.ts

src/app/dialer/
├── page.tsx
└── components/
    ├── Softphone.tsx                # Voice SDK integration
    ├── AmmunitionPanel.tsx          # hydrates on call.connected SSE
    └── SessionControls.tsx

tests/
├── pacing.control-law.test.ts       # Milestone 1a
├── race-resolver.property.test.ts   # Milestone 1b
├── webhook.idempotency.test.ts
├── reconciliation.test.ts
├── ammunition.latency.test.ts
├── status-map.test.ts               # canceled -> cancel etc.
└── contract/
    ├── emits.call.connected.test.ts
    ├── emits.call.completed.test.ts
    ├── emits.pacing-update.test.ts
    ├── consumes.queue.mock.test.ts
    └── consumes.callable-now.mock.test.ts
```

**Local Postgres for tests** (needed by Milestone 1b): use Testcontainers explicitly — don't add a homegrown `docker:pg-test` script. In `tests/setup/pg.ts`:

```typescript
import { PostgreSqlContainer } from "@testcontainers/postgresql";
export async function startTestPg() {
  return await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("crm_test")
    .withUsername("test")
    .withPassword("test")
    .start();
}
```

Global-setup starts one container per test run and exports `DATABASE_URL_MAIN` for Vitest. `prisma migrate deploy` runs in setup against that URL.

---

## 10. Milestones + Implementation Plan

**Milestones 1a and 1b are FRONT-LOADED per Ryan's explicit directive. Do these BEFORE anything else — before Twilio integration, before the UI, before webhooks. If they don't work, nothing built on top of them will work.**

### Milestone 1a — Pacing control law (WEEK 1)

**Goal:** prove the pacing math with exhaustive band-boundary tests, using synthetic `PacingMetric` inputs. No Twilio, no browser, no UI.

**Deliverable:** a pure function

```typescript
// src/lib/telephony/pacing/computeNewLineCount.ts
export interface PacingInput {
  currentLineCount: number;
  maxLineCount: number;
  thirtyDayAbandonment: number;    // fraction 0.0–1.0
  amdFalsePositiveRate24h: number; // fraction 0.0–1.0
  monthlySpendUsd: number;
  monthlySpendCapUsd: number;
}
export interface PacingDecision {
  newLineCount: number;
  action: "increase" | "hold" | "decrease" | "force-single" | "halt";
  warn?: string;
  halt?: { reason: "abandonment" | "spend"; abandonmentPct?: number; };
  raiseAmdThreshold?: boolean;
}
export function computeNewLineCount(input: PacingInput): PacingDecision;
```

**Band logic (implement EXACTLY, with explicit [low, high) inclusivity):**

Let `a = thirtyDayAbandonment` (fraction). Bands are half-open intervals `[low, high)`:

| Band | Interval | Action | newLineCount |
|---|---|---|---|
| 1 | `a ∈ [0.000, 0.015)` | MAY increase by 1 | `min(current + 1, maxLineCount)` |
| 2 | `a ∈ [0.015, 0.020)` | HOLD | `current` |
| 3 | `a ∈ [0.020, 0.025)` | DECREASE by 1, min 1. `warn` set. | `max(current - 1, 1)` |
| 4 | `a ∈ [0.025, 0.028)` | FORCE single-line. `warn` set. | `1` |
| 5 | `a ∈ [0.028, ∞)` | HALT. `halt: { reason: "abandonment", abandonmentPct: a*100 }` set. | `0` |

Boundary check for the executor: `0.0149 → band 1`, `0.015 → band 2`, `0.0199 → band 2`, `0.020 → band 3`, `0.0249 → band 3`, `0.025 → band 4`, `0.0279 → band 4`, `0.028 → band 5`, `0.05 → band 5`.

**AMD-FP interaction (applied AFTER the abandonment decision, unless halt is set):**
- If `amdFalsePositiveRate24h > 0.015`: set `raiseAmdThreshold=true` and additionally decrease `newLineCount` by 1 (min 1). Never below 1 via this path.
- If halt is set by abandonment (band 5) OR spend, AMD-FP is ignored — halt wins.

**Spend-cap interaction (checked FIRST, before abandonment):**
- If `monthlySpendUsd >= monthlySpendCapUsd`: return `{ newLineCount: 0, action: "halt", halt: { reason: "spend" } }`. Do not evaluate abandonment or AMD-FP.

**Invariant:** `newLineCount ∈ {0} ∪ [1, maxLineCount]`. The value `0` is reserved for halt states (abandonment band 5 OR spend). All non-halt decisions produce `newLineCount ∈ [1, maxLineCount]`. If `currentLineCount > maxLineCount` on input (out-of-band), clamp to `maxLineCount` at output.

**AMD-FP / abandonment double-count semantics (READ THIS — do not "fix" it):**

The abandonment numerator IS intentionally `sum(abandonedCalls) + sum(amdFalsePositive)`. Rationale: FTC's abandonment definition (16 CFR 310.4(b)(4)) treats a call answered by a human but disconnected within 2 seconds of the human's greeting as an "abandoned call" — and an AMD false-positive (machine flagged human, then dropped by Twilio into voicemail-treatment or hung up on a live person) IS exactly that class of event. So the same event legitimately contributes to (a) the abandonment ratio that drives the halt band AND (b) the standalone AMD-FP rate that drives the raise-AMD-threshold branch. Not a bug. Do not de-duplicate.

Document this in `docs/pacing-control-law.md` prominently.

**Files:**
- `src/lib/telephony/pacing/computeNewLineCount.ts` — pure function.
- `tests/pacing.control-law.test.ts` — Vitest.

**Tests — write ALL of these:**
- Every band boundary as `[low, high)`: exact values `{0.0149, 0.015, 0.0199, 0.02, 0.0249, 0.025, 0.0279, 0.028, 0.05}`.
- `currentLineCount` at 1, at `maxLineCount`, above `maxLineCount` (should clamp to `maxLineCount` on the increase path AND on the hold path).
- `amdFalsePositiveRate24h` at `{0.0, 0.015, 0.0151, 0.05}` in combination with each abandonment band.
- Spend cap: at, just under, just over — spend at cap OR above → halt with `reason: "spend"`; nothing else evaluated.
- Interaction: high AMD-FP + low abandonment → still decreases by 1, `raiseAmdThreshold=true`.
- Interaction: halt-abandonment + high AMD-FP → halt wins, `raiseAmdThreshold` may or may not be set (implementation choice — document).
- Interaction: spend-cap + high abandonment → spend halt wins.
- Property test: for any random valid input, `newLineCount ∈ {0} ∪ [1, maxLineCount]`; `newLineCount === 0` iff `action === "halt"`.

**Proof of done:**
- `pnpm vitest run tests/pacing.control-law.test.ts` — all pass.
- 100% branch coverage of `computeNewLineCount.ts` (`pnpm vitest run --coverage`).
- No I/O, no Prisma, no imports outside pure Node.

### Milestone 1b — Two-legs-answer race resolver (WEEK 1)

**Goal:** prove that Postgres advisory locks correctly serialize concurrent AMD-human callbacks for the same `Call.id`, so exactly one leg wins even under real network-timing chaos.

**Deliverable:** a helper

```typescript
// src/lib/telephony/race-resolver/acquireWinner.ts
import { Prisma } from "@prisma/client";

/**
 * Attempt to acquire the "winner" lock for a Call. Returns true iff this
 * caller is the winner. Must be invoked inside a transaction — the lock
 * is released on tx commit or rollback.
 */
export async function tryAcquireCallWinner(
  tx: Prisma.TransactionClient,
  callId: string
): Promise<boolean> {
  // Use hashtextextended for 64-bit hash space; collision-free for any
  // realistic callId cardinality. Two-arg form: (text, seed) -> bigint.
  const rows = await tx.$queryRawUnsafe<{ won: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) as won`,
    callId
  );
  return rows[0].won;
}
```

And the losing-side handler:

```typescript
// src/lib/telephony/race-resolver/droppedLoser.ts
/**
 * Update CallLeg to disposition='dropped-loser', droppedLoserMessage=true,
 * return the TwiML XML that plays the professional message and hangs up.
 * Reads RACE_LOSER_TWIML_MODE / _TEXT / _MP3_URL from env.
 */
export async function markLoserAndBuildTwiml(
  prisma: PrismaClient,
  legSid: string
): Promise<string>;
```

**Loser TwiML message (Ryan-decision blocker — placeholder until approved):**

The default text is a placeholder proposed by Agent B:

> "Sorry, our agent just stepped away. We'll call you back shortly."

**This string is NOT in shared context and NOT Ryan-approved.** File a §13 planner request the moment you reach Milestone 1b:

> "Milestone 1b needs the exact loser-message text OR an MP3 URL. Placeholder text: '<default>'. Please approve verbatim or provide alternative. Also confirm: `<Say>` (robotic TTS) or `<Play>` with pre-recorded MP3? TCPA-sensitive — a pre-recorded human voice sounds less like an autodialer."

Two modes controlled by env (§5):
- `RACE_LOSER_TWIML_MODE=say` → `<Response><Say voice="Polly.Joanna">${RACE_LOSER_TWIML_TEXT}</Say><Hangup/></Response>`
- `RACE_LOSER_TWIML_MODE=play` → `<Response><Play>${RACE_LOSER_TWIML_MP3_URL}</Play><Hangup/></Response>`

Do NOT hard-code the string in source. All three env vars are the seam Ryan can flip without a code change.

**Tests — `tests/race-resolver.property.test.ts`:**
Requires a REAL Postgres via Testcontainers (see §9). Do NOT mock this — the whole point is to prove atomicity under real concurrency.

- Property test: for `N ∈ [10, 100]`, spawn N concurrent calls to `tryAcquireCallWinner` for the same `callId` using `Promise.all` where each call runs in its own `prisma.$transaction`. Assert exactly ONE returned true.
- Different `callId`s: 100 concurrent attempts across 10 different callIds → each callId has exactly 1 winner.
- Rollback releases the lock: winner rolls back their tx → a fresh attempt succeeds.
- Commit releases the lock: winner commits → a fresh attempt also succeeds (advisory locks are per-tx, not per-Call.id).
- Timing: the whole 100-concurrent-attempt test completes in under 3 seconds.
- Env-mode test for `markLoserAndBuildTwiml`: with `RACE_LOSER_TWIML_MODE=say` returns `<Say>` element; with `MODE=play` returns `<Play>` element pointing at the MP3 URL.

**Proof of done:**
- `pnpm vitest run tests/race-resolver.property.test.ts` — all pass against real Postgres.
- Advisory lock behavior verified in `psql` manually: run `SELECT pg_try_advisory_xact_lock(hashtextextended('call_test', 0))` in two sessions, confirm second returns false, first commits, second succeeds.

**DO NOT PROCEED to Milestone 2 until 1a and 1b are green in CI.**

---

### Milestone 2 — Twilio integration (WEEK 2)

**Goal:** place a real Twilio call via API against test credentials, receive AMD result via signed webhook, update `Call` and `CallLeg` state deterministically.

**Prereqs:**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` set (test creds work here).
- ngrok or Cloudflare Tunnel exposing `http://localhost:3000` for webhook receipt.
- `TWILIO_VOICE_WEBHOOK_BASE=https://<tunnel>/api/telephony/webhook` in Doppler dev.

**File §13 planner requests at the START of this milestone** for the three §6.1 schema-drift items (composite `@@unique` on CallLeg, `Call.source` default, `Call.status` enum). Proceed with the workarounds described in §6.1 while awaiting response.

**Implementation:**
1. `src/lib/telephony/twilio/client.ts` — singleton `Twilio(accountSid, authToken)`.
2. `src/lib/telephony/twilio/signature.ts` — middleware that runs `twilio.validateRequest(authToken, signature, url, params)` and 403s on failure. Wrap every webhook route with it.
3. `src/lib/telephony/twilio/statusMap.ts` — `mapTwilioStatus(twilioStatus: string): CallStatus` — implements the `canceled → cancel` mapping and any others. Log unknown statuses via pino at warn level.
4. `src/lib/telephony/dial-loop/placeCall.ts`:
   - Call Twilio FIRST, then insert `Call` with the real `providerCallSid`. Twilio call: `calls.create({ to, from: callerId, url: <TWIML_URL>, method: 'POST', statusCallback: <STATUS_URL>, machineDetection: 'DetectMessageEnd', asyncAmd: 'true', asyncAmdStatusCallback: <TWIML_URL>, timeout: ringTimeoutSec })`.
   - Insert `Call` + initial `CallLeg` in one tx. Set `Call.source = "dealflow-crm"` explicitly (override the schema default per §6.1).
   - **Orphan-Twilio-call recovery:** if Twilio create succeeds but DB insert fails, the reconciliation job catches these: it queries `twilio.calls.list({ startTimeAfter: <window> })`, checks each SID against our DB, and issues a `calls(sid).update({ status: 'canceled' })` for any orphan older than 60s. Add this to the recon job in Milestone 5.
5. `src/app/api/telephony/webhook/voice/route.ts`:
   - Twilio POSTs here when the call is answered. Async AMD means Twilio will POST TWICE: once immediately with just call info, once with AMD result (`AnsweredBy=human|machine_start|machine_end_beep|machine_end_silence|machine_end_other|fax|unknown`).
   - First POST: return `<Response><Pause length="30"/></Response>` (holds the call while AMD decides).
   - Second POST (asyncAmdStatusCallback): parse `AnsweredBy`.
     - `human` / `unknown` → attempt `tryAcquireCallWinner`. If winner: return TwiML that dials into a Twilio Conference room named `conf_<callId>`, into which the operator's Voice SDK client is also joined. If loser: run `markLoserAndBuildTwiml` and return that TwiML.
     - `machine_*` → return `<Response><Hangup/></Response>`. Update `CallLeg.disposition='vm-answer'`. Update `Call.disposition='vm-answer'`.
     - `fax` → same as machine.
   - Idempotency: keyed on `(CallSid, AnsweredBy)`. Same webhook replayed → same DB state. Implementation: SELECT `CallLeg WHERE providerLegSid = <CallSid> FOR UPDATE` inside the tx; if `amdResult` already set to the same value, no-op; if different, log Sentry (Twilio changed its mind, rare).
6. `src/app/api/telephony/webhook/status/route.ts`:
   - Idempotent on `CallSid`. Transition `Call.status` per Twilio's `CallStatus` param, mapped via `statusMap.ts`. On terminal statuses (`completed`, `no-answer`, `busy`, `failed`, `cancel`): compute `disposition`, write `duration` and `cost` (from `CallDuration` and `Price`), emit `call.completed` event in same tx, set `emittedAt = now()`.

**Tests — `tests/webhook.idempotency.test.ts` + `tests/status-map.test.ts`:**
- Replay same voice-webhook payload 3× → single `CallLeg.amdResult` write, single `call.connected` emission if human.
- Replay same status webhook 3× → single `call.completed` emission (guarded by `emittedAt`).
- Invalid signature → 403.
- AMD-human winner + AMD-human loser for same `callId` → exactly one wins, one dropped-loser leg, one `abandonedCalls` increment.
- `mapTwilioStatus('canceled')` returns `'cancel'`; `mapTwilioStatus('completed')` returns `'completed'`; unknown status returns null and logs warn.
- Explicit test: `Call.source` defaults to `"dealflow-crm"` on every insert path (not `"Close.io"`).
- **Emission wire-format test:** capture the JSON payload written to `pg_notify('crm_call', ...)` on `call.completed`; assert `type === "call.completed"` (no `eventName` field present) and `typeof payload.cost === "string" || payload.cost === null` (decimal-as-string, not number). Per §8.3 items 1 and 2.

**Proof of done:**
- Place a real call via test creds against your own cell phone. Answer it, hear silence (no conference bridge yet — that's Milestone 3). Hang up. Check DB: `Call.status='completed'`, `disposition='answered'`, `source='dealflow-crm'`, `call.completed` event visible in `pg_notify` listener.

---

### Milestone 3 — Softphone UI + Conference bridge (WEEK 2)

**Goal:** the browser can answer and speak on a call routed via Twilio Conference.

**Leg-count and cost accounting (READ FIRST):**

An answered outbound call in this design uses TWO billed Twilio legs:
- Leg A: the outbound PSTN dial to the callee (`Call.providerCallSid`, tracked as the primary `CallLeg`).
- Leg B: the operator's Voice SDK client joining `conf_<callId>` (client-to-Twilio; typically much cheaper — usually zero PSTN cost).

Plus Twilio Conference fees per participant-minute in some pricing tiers.

**How `Call.cost` aggregates:** `Call.cost` is set from Twilio's `Price` param on the STATUS CALLBACK for the primary outbound leg only (Leg A). The operator's client-to-Twilio leg (Leg B) accrues negligible cost but is NOT summed into `Call.cost`. The monthly spend-cap math (§10 Milestone 5) is `sum(Call.cost)` and therefore under-counts total Twilio spend by the client-side leg. For MVP this is acceptable — the client leg is bounded (one operator, one call at a time per client), pricing tiers where it matters are exotic, and the spend cap has a 20%+ buffer. Document this in `docs/pacing-control-law.md`.

If we ever add per-leg cost tracking, that's a schema-drift proposal (add `CallLeg.cost Decimal?`) — file via §13. NOT in scope for MVP.

**Implementation:**
1. `src/app/api/telephony/calls/token/route.ts` — issue Voice SDK access token with a `VoiceGrant` (incoming allow, identity = `user_<userId>`).
2. `src/app/dialer/page.tsx` + `Softphone.tsx`:
   - Load `@twilio/voice-sdk`. Fetch token from `/api/telephony/calls/token`. Register a Voice `Device`.
   - When `call.connected` arrives via SSE, the Softphone should already have joined `conf_<callId>` — the voice webhook TwiML for the operator side dials the conference. Detail:
     - Operator side: when the user clicks "Start Session" the Voice Device stays warm. On `call.connected` SSE, the client places an outbound Voice SDK connect (`device.connect({ params: { conferenceName: 'conf_<callId>' } })`), and a separate TwiML app route serves `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">conf_<callId></Conference></Dial></Response>`.
   - Mute / unmute, DTMF, hang up buttons.
3. `AmmunitionPanel.tsx` — subscribes to SSE stream on the `crm_call` bridge. On receipt of `call.connected` for the active session, fetches `GET /api/telephony/calls/:id/ammunition` and renders the panel. Dispatch on `type === "call.connected"` (per §8.3 item 1); ignore events with other `type` values (e.g. `dial-session.pacing-update`).

**Latency budget** (Ryan-critical): from `call.connected` server-side emission → panel visible in the browser ≤ 200ms p95. Anchor is explicitly `pg_notify('crm_call', ...)` firing on the server-side commit (which happens AFTER Twilio's async AMD detection window ~3-5s — that latency is Twilio's, out of our control). Instrument via `performance.now()` in the browser + pino spans server-side. Log with correlationId end-to-end.

**Tests — `tests/ammunition.latency.test.ts`:**
- Simulated flow: insert a Call/Lead/DerivedSignal, emit `call.connected`, subscribe SSE, timestamp receipt, fetch ammunition endpoint, timestamp render. Assert < 200ms p95 across 20 runs (allow 1 outlier ≤ 500ms).

**Proof of done:**
- Real call → operator answers via browser → speaks to Ryan on his cell → ammunition panel populates with Lead + DerivedSignal within 200ms of `call.connected` emission → hang up → panel clears.

---

### Milestone 4 — Dial loop + inline compliance + pacing worker (WEEK 3)

**Goal:** a full power/predictive session that pulls contacts from Agent A's queue, calls Agent C inline before every dial, respects the pacing decision, and stops on halt.

**Implementation:**
1. `src/lib/telephony/dial-loop/nextContact.ts`:
   - `GET ${QUEUE_SERVICE_BASE_URL}/api/queue?viewId=<viewId>&limit=50`. Parse with a `.passthrough()` Zod schema so A-side additive fields (e.g. `excludedNoPhone`, `stale`) don't break; extract `primaryPhoneE164` (not `primaryPhone` — per §8.3 item 6). Cache the list in memory; refetch when exhausted.
   - **Apply the local dropped-loser 72h exclusion per §4.1**: skip any `contactPhoneId` where the most recent `CallLeg` with `disposition='dropped-loser'` AND `droppedLoserMessage=true` AND `startedAt >= now() - interval '72 hours'` exists. Query is a Prisma `groupBy` on your OWN `CallLeg` table.
   - **Do NOT synthesize a timezone** if the queue entry has `timezone: null`. Pass the raw `contactPhoneId` to Agent C and let C fail-closed (per §8.3 item 8). This will produce a `callable: false` result with `reasons: ["timezone_unresolved"]`, which B logs as `compliance_blocked` and moves to the next contact.
   - If the queue response has `stale: true`, log Sentry warning with `staleReason` but proceed to dial.
2. `src/lib/telephony/dial-loop/session.ts`:
   - State machine: `active → paused → active | ended`.
   - On start, fork a loop that:
     - Reads current `DialSession.lineCount`.
     - Ensures the number of in-flight `CallLeg`s (status pending) === lineCount.
     - For each open slot, call `nextContact()` → `POST ${COMPLIANCE_SERVICE_BASE_URL}/api/compliance/callable-now` with the contact's `primaryPhoneId` in `contactPhoneIds: [id]`. Do NOT pass `atInstant`. Do NOT batch above 100 per request (§8.3 item 6). **Fail-closed: on error, mark callable:false and skip.**
     - Parse response with a Zod schema that expects BOTH `contactPhoneId` AND `phone` on each result entry, and `reasons[]` values drawn from `REASON_CODES` (§8.4). Log Sentry warning on any unknown reason code (indicates C-side drift).
     - If callable: `placeCall()`.
     - If not callable: log to Sentry (`compliance_blocked` with `reasons` array), move to next contact. (Agent C is authoritative for the `ScrubLog` write — Agent B does not attempt to record scrub state.)
3. `src/lib/telephony/pacing/worker.ts`:
   - Runs every `PACING_INTERVAL_SECONDS` (default 60).
   - Compute rolling 30-day abandonment across all `PacingMetric` rows: `(sum(abandonedCalls) + sum(amdFalsePositive)) / sum(dialsInitiated)` — deliberately double-counting AMD-FPs as abandonments per FTC rule (see §10 Milestone 1a). Guard against zero denominator (return 0.0).
   - Compute rolling 24h AMD-FP rate: `sum(amdFalsePositive) / sum(dialsInitiated)` over the last 24h.
   - Compute month-to-date Twilio spend (`sum(cost)` from `Call` where `activityAt >= date_trunc('month', now() at time zone 'UTC')`).
   - Call `computeNewLineCount()` per active `DialSession`. Update `DialSession.lineCount`. Insert a fresh `PacingMetric` row with `currentLineCount` snapshot.
   - Emit `dial-session.pacing-update` per session (payload includes `type: "dial-session.pacing-update"` discriminant per §8.3 item 1).
   - On `halt`: transition all active sessions to `paused`, set global `halted=true` flag using the sentinel-row approach: a `PacingMetric` row with `dialSessionId=null` and `currentLineCount=-1` and a JSON-encoded halt reason serialized into a helper column via the `minuteBucket` being the halt-time (audit trail). **File §13 planner request** to add a dedicated `SystemState` singleton table (owned by Agent B for now, or moved to shared) — for MVP, sentinel row is acceptable.
   - Sentry alert on halt.
4. `src/app/api/telephony/pacing/status/route.ts` — reads latest `PacingMetric` for the session; also reports the global halt flag via the sentinel row.
5. `src/app/api/telephony/pacing/resume/route.ts` — bearer `CRON_SECRET`. Clears halt flag by inserting a fresh `PacingMetric` sentinel row with `currentLineCount=0` meaning "un-halted."

**File §13 requests at start of Milestone 4:**
- Confirm the 72-hour dropped-loser exclusion locus (Agent B local — see §4.1).
- Confirm the `timezone: null` → C fail-closed semantics (§8.3 item 8) match what A/C actually shipped. Do not proceed to real integration until confirmed.

**Tests:**
- `tests/dial-loop.compliance-fail-closed.test.ts` — inline mock of callable-now that throws → no dial placed, no `Call` row.
- `tests/dial-loop.dropped-loser-exclusion.test.ts` — a contact with a `dropped-loser` `CallLeg` within 72h is skipped; a `dropped-loser` at 73h is NOT skipped.
- `tests/dial-loop.timezone-unresolved.test.ts` — queue entry with `timezone: null` → C mock returns `callable: false, reasons: ["timezone_unresolved"]` → no dial placed, Sentry `compliance_blocked` logged.
- `tests/dial-loop.stale-queue.test.ts` — queue response with `stale: true` → dial proceeds, Sentry warning logged with `staleReason`.
- `tests/dial-loop.reason-code-unknown.test.ts` — C mock returns a reason value outside `REASON_CODES` → Sentry warning logged, dial still blocked (fail-closed).
- `tests/pacing.worker.integration.test.ts` — seed PacingMetric rows for a synthetic history at each band, run one tick of the worker, assert `DialSession.lineCount` transitioned correctly.
- Circuit-breaker test: pacing worker sees 3% abandonment → all sessions paused → subsequent POST `/api/telephony/dial-sessions` returns 503 `{ error: "pacing_halted", abandonmentPct }`.

**Proof of done:**
- End-to-end: create a SavedView in the mock queue service returning 5 test numbers; start a session with `method=power lineCount=1`; watch 5 calls execute; verify each was preceded by a `callable-now` check.

---

### Milestone 5 — Reconciliation + recordings + cost cap (WEEK 3)

**Goal:** eliminate the "webhook-delivered-once-or-never" class of bug; store recordings in R2; halt on monthly spend cap.

**Implementation:**
1. `src/lib/telephony/reconciliation/job.ts`:
   - Runs every 5 minutes.
   - **Sub-job A — stuck-call state converge:** query `Call` where `status IN ('created', 'in-progress')` AND `dateCreated < now() - interval '6 minutes'`. For each, fetch Twilio Rest API `calls(providerCallSid).fetch()`. Update local state (`status`, `duration`, `cost`, `disposition`) from Twilio's answer. Emit `call.completed` if terminal.
   - **Sub-job B — orphan Twilio calls:** query Twilio `calls.list({ startTimeAfter: <5min ago> })`; for each SID not in our `Call` table, issue `calls(sid).update({ status: 'canceled' })`. Log to Sentry.
   - **Sub-job C — lost-emission recovery:** scan `Call` where `status` is terminal AND `emittedAt IS NULL AND dateCreated < now() - interval '2 minutes'`; re-emit `call.completed` in a tx that sets `emittedAt = now()`. (Requires the schema-drift request for `emittedAt` filed at start of Milestone 5 per §7.3; until it lands, use the in-memory `_CallEmissionOutbox` sentinel table.)
   - **Twilio Rest API down handling:** on repeated 5xx from Twilio (>3 consecutive failures in a 5-min window), skip sub-jobs A and B for that tick, keep sub-job C running (DB-only), Sentry alert. After 3 failed ticks (~15 min), page (Sentry alert with severity `critical`). Do not retry indefinitely; the next scheduled tick is the retry.
2. `src/app/api/telephony/webhook/recording/route.ts` + `src/lib/telephony/twilio/recording.ts`:
   - On `RecordingStatus=completed`, fetch `${RecordingUrl}.mp3` with basic auth (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`), PUT to R2 at `recordings/<callId>.mp3` using AWS S3 SDK v3 (R2 is S3-compatible).
   - Update `Call.recordingUrl = 'recordings/<callId>.mp3'`, `Call.recordingDurationSec = RecordingDuration`.
   - NEVER return the R2 URL directly to clients — expose via `GET /api/telephony/calls/:id/recording` (302-redirect to a presigned R2 URL, TTL 300s).
3. `src/lib/telephony/cost/monthlyCap.ts`:
   - Called from the pacing worker.
   - `monthlySpendUsd = sum(Call.cost) WHERE activityAt >= date_trunc('month', now() at time zone 'UTC')`.
   - Included in `computeNewLineCount` input.
   - Aggregates outbound-leg cost only (see Milestone 3 leg-cost note); client-side leg cost is not summed.

**File §13 request at start of Milestone 5:** add `Call.emittedAt DateTime?` to the shared schema.

**Tests:**
- `tests/reconciliation.test.ts` — mock Twilio Rest API; seed a stuck `Call` older than 6min; run job; assert state converged; assert lost-emission sub-job re-fires `call.completed`; assert orphan-Twilio cleanup.
- `tests/webhook.recording.test.ts` — mock Twilio download + R2 PUT; assert `Call.recordingUrl` set.
- `tests/cost.monthly-cap.test.ts` — seed cost rows summing above cap; assert pacing decision returns `halt: { reason: "spend" }` AND subsequent POST `/api/telephony/dial-sessions` returns 503 `{ error: "spend_cap_reached", monthlySpendUsd }`.

**Proof of done:**
- Run a real test-cred call → recording appears in R2 → download via presigned URL via `GET /api/telephony/calls/:id/recording` → plays.

---

### Milestone 6 — Contract tests (WEEK 3, parallel to 5)

**Goal:** pass Gate 2 in both directions.

- `tests/contract/emits.call.connected.test.ts` — trigger a `call.connected` emission, subscribe on `crm_call`, assert payload matches `CallConnectedEvent` Zod schema exactly (field names, types, `type` discriminant present, no `eventName`).
- `tests/contract/emits.call.completed.test.ts` — same for `call.completed`. Additionally assert `cost` is `string | null` on the wire (not `number`), per §8.3 item 2.
- `tests/contract/emits.pacing-update.test.ts` — same for `dial-session.pacing-update`.
- `tests/contract/consumes.queue.mock.test.ts` — start the queue mock service at `contracts/mocks/core-data/queue/`, run `nextContact()`, assert it accepts the mock's response shape including `primaryPhoneE164`, `displayName`, `timezone` (nullable), and passthrough fields (`excludedNoPhone`, `excludedCompliance`, `stale`, `staleReason`). Assert it does NOT crash when `stale: true` or `timezone: null`.
- `tests/contract/consumes.callable-now.mock.test.ts` — start the compliance mock at `contracts/mocks/compliance/callable-now/`, exercise:
  - `callable:true` response with `contactPhoneId` + `phone` both present.
  - `callable:false` response with `reasons[]` values drawn from `REASON_CODES`.
  - Timeout → confirm fail-closed.
  - Response missing `phone` field → Sentry warning + fail-closed (contract drift).
  - Response with unknown `reasons[]` value → Sentry warning + still fail-closed if `callable:false`.
  - Request body with >100 `contactPhoneIds` → HTTP 413 (do not send this in production; B's dial loop never batches, but the mock must model the cap).

---

## 11. The Three Acceptance Gates

### Gate 1 — Runs in isolation

The slice boots on its own, connects only to its own tables, and responds to requests, with EVERY dependency mocked from `contracts/mocks/` and NO other agent's code present.

**Exact boot command for isolation:**

```bash
# Terminal 1: start mock services
doppler run --config dev -- pnpm mocks:up
# runs contracts/mocks/core-data (port 4101) and contracts/mocks/compliance (port 4102)

# Terminal 2: start slice
QUEUE_SERVICE_BASE_URL=http://localhost:4101 \
COMPLIANCE_SERVICE_BASE_URL=http://localhost:4102 \
doppler run --config dev -- pnpm dev

# Terminal 3: place a test call
curl -X POST http://localhost:3000/api/telephony/dial-sessions \
  -H 'Content-Type: application/json' \
  -H 'x-correlation-id: 00000000-0000-0000-0000-000000000001' \
  -d '{"viewId":"save_mocktest","method":"power","lineCount":1,"callerId":"+15555550100"}'
```

Agent B must start a dial session against the FAKE Smart View endpoint that returns canned numbers (with `primaryPhoneE164`, nullable `timezone`, passthrough telemetry fields), place calls against Twilio TEST credentials, and drive its full state machine (create → in-progress → completed) with Agents A, C, and D absent.

### Gate 2 — Honors the contract (BOTH DIRECTIONS)

Slice passes the contract test suite in both directions:
- Contract tests against the slice's OWN real service — proves it EMITS and ACCEPTS the frozen shapes: `call.connected` carries `type` / `callId` / `dialSessionId` / `remotePhone` etc. exactly per §7.1 Zod schemas (with `type` discriminant, no `eventName`, `cost` as decimal-string); `/api/telephony/dial-sessions` accepts the exact request/response shape per §8.1.
- Contract tests against the MOCKS the slice consumes — proves those mocks are faithful for `GET /api/queue` (with `primaryPhoneE164`, nullable `timezone`, passthrough) and `POST /api/compliance/callable-now` (with `contactPhoneId` + `phone`, `REASON_CODES` vocabulary, 100-cap 413), so when the mock is swapped for the real service at integration, it fits the same socket.

Both directions must be green.

### Gate 3 — Does its job

Behavioral acceptance tests specific to the slice's purpose, plus a coverage floor.

**Critical paths (must have 90% branch coverage):**
- Pacing control law — all-band boundary tests. `src/lib/telephony/pacing/computeNewLineCount.ts` at 100%.
- Two-legs-answer race resolver — property test spawning 100 concurrent AMD-human callbacks against real Postgres; assert exactly one winner.
- Webhook reconciliation — replay-safety: same payload delivered 3× → same DB state as 1×. Lost-emission recovery: state without emission → recon fires emission exactly once.
- AMD-false-positive counting integrates correctly into abandonment (documented double-count semantics).
- Circuit breaker halt + resume flow.
- Ammunition data hydration <200ms p95 anchored at `call.connected` emission.
- Twilio status mapping (`canceled` → `cancel`) covered.
- Dropped-loser 72h local exclusion covered.
- Wire-format assertions covered: event `type` discriminant, `cost` as string, `queue.primaryPhoneE164`, `callable-now` `contactPhoneId + phone + REASON_CODES`, timezone-null fail-closed pass-through.

**CI enforcement:**
- `pnpm test` runs all Vitest suites.
- `pnpm test:coverage` enforces 90% branch coverage on `src/lib/telephony/pacing/**` and `src/lib/telephony/race-resolver/**`, 80% on the rest of `src/lib/telephony/**`.
- CI job fails on either.

**No slice enters integration RED.**

---

## 12. Failure-Mode Behavior

| Failure | Behavior |
|---|---|
| Twilio unreachable mid-session | HALT gracefully. In-flight legs complete or terminate normally. Reconciliation job catches strays after Twilio comes back. Never strand a leg. Sentry alert. |
| Compliance service (Agent C) unreachable at dial time | **FAIL CLOSED.** Halt the dial. Don't dial without positive-safe signal. |
| Compliance service returns unknown `reasons[]` value | Sentry warning (indicates C-side drift outside `REASON_CODES`); still respect the `callable` boolean (fail-closed if false). |
| Compliance service response missing `phone` or `contactPhoneId` field | Contract drift. Sentry warning; treat that entry as `callable:false`. |
| Queue response has `stale: true` | Log Sentry warning with `staleReason`; proceed to dial (A's ranker being late is not B's problem). |
| Queue response has `timezone: null` for a lead | Pass `contactPhoneId` unchanged to C; C fail-closes with `timezone_unresolved`. B logs `compliance_blocked` and moves on. |
| Webhook signature validation fails | 403. Never process unsigned webhooks. |
| R2 unreachable for recording storage | Sentry alert, retain the Twilio-side recording URL for later retry via nightly job. Don't fail the call. |
| Advisory-lock DB unreachable in race resolver | Both legs treated as losers → both get the loser TwiML → both hang up. Worse than one-loser but safer than double-connect. Sentry alert. |
| Queue endpoint (Agent A) returns 0 rows | Pause session with `status='paused'`, reason logged. UI shows "queue empty." |
| Pacing worker crash | Pod restarts. On boot, worker resumes from latest `PacingMetric` state. Sessions remain in their last known `lineCount`. |
| Monthly spend cap hit | Halt behavior. `POST /api/telephony/dial-sessions` returns 503 `{ error: "spend_cap_reached" }`. Requires manual `POST /api/telephony/pacing/resume` (or new billing cycle). |
| Twilio Rest API down (reconciliation) | Skip sub-jobs A and B for the tick, keep sub-job C (DB-only lost-emission recovery). Sentry alert at 3 consecutive failed ticks (~15 min). |
| Orphan Twilio call (create succeeded, DB insert failed) | Reconciliation sub-job B cancels the Twilio call within ~5 min. |
| `call.completed` emission lost (listener disconnected) | Reconciliation sub-job C re-fires the emission within ~5 min. `emittedAt` idempotency guard prevents double-emit. |

---

## 13. Contract Change Protocol

If you discover a frozen contract is wrong OR need to add a schema field: **STOP. Do not work around locally without also filing the request. Message the planner (Ryan).**

The planner updates `dealflow-crm/CONTRACTS.md` + contract-test schemas + `prisma/schema.prisma` + notifies all agents to re-pull. Never silently patch a mismatch — that's how 4-agent parallelism collapses.

**Specific contract-change requests you WILL file during this build:**

1. **Milestone 1b start:** loser TwiML message — need Ryan-approved verbatim text OR MP3 URL. `<Say>` vs `<Play>` choice.
2. **Milestone 2 start:** three schema-drift items per §6.1:
   - Composite `@@unique([callId, providerLegSid])` on `CallLeg`.
   - `Call.source` default change `"Close.io"` → `"dealflow-crm"`.
   - `Call.status` enum: reconcile `'cancel'` vs Twilio `'canceled'`.
3. **Milestone 4 start:**
   - 72-hour dropped-loser exclusion locus confirmation (Agent B local per §4.1; confirm or reassign).
   - Confirm `timezone: null` → C fail-closed semantics (§8.3 item 8) match what A/C actually shipped.
4. **Milestone 5 start:** add `Call.emittedAt DateTime?` for lost-emission recovery per §7.3.
5. **Milestone 4:** if the pacing halt sentinel-row approach smells wrong, propose dedicated `SystemState` singleton.
6. **On C-side drift:** if the callable-now mock or real service returns unknown `reasons[]` values, or omits `contactPhoneId` / `phone`, file a request pointing at the drift with a captured payload sample. Do NOT accept the drift as new normal.

**What you may do without filing (and why):**

- Idempotency in application code (SELECT-then-INSERT within tx) while awaiting schema uniqueness constraints — this is safe and reversible.
- Explicit override of `Call.source` at insert time — this is application-level and reversible.
- Explicit Twilio-status → local-status mapping in your handler — required for basic operation.
- Local dropped-loser filter in `nextContact()` — this is a read of your own table; not a contract change.
- Zod `.passthrough()` on consumed schemas so A can add fields without breaking B — future-proofing, not a contract change.

Never SILENTLY edit the schema. Every schema edit requires a filed §13 request FIRST.

---

## 14. Ryan's Preferences (Must Follow)

- **Always type deliverables in chat as full copyable text.** Ryan pastes into the next executor session. If you produce a summary at the end, put it in your chat response, not a file.
- **`import 'dotenv/config'` MUST be the first import of any script that touches DB** — else Prisma silently defaults to localhost. Applies to `scripts/*.ts` and any standalone Node process. In Next.js API routes this is auto-loaded — no action needed.
- **Run `npx prisma generate` between `prisma migrate dev` and `tsc`** — stale types will mask real errors otherwise. Add this to your workflow every time you edit `schema.prisma`.
- **iCloud landmine:** the repo lives in iCloud Drive. iCloud creates duplicate files named ` 2.tsx` / ` 2.ts` that fool grep-based audits. Before committing, run:
  ```bash
  find . -type f \( -name "* 2.ts" -o -name "* 2.tsx" -o -name "* 2.js" \) -not -path "./node_modules/*"
  ```
  Delete any hits. Rebuild `.next` (`rm -rf .next && pnpm build`) if tsc trips on iCloud dups.
- **Prisma sequential `.create()` against Railway ≈ 90ms/row over network.** Bulk writes >100 rows need `createMany({ skipDuplicates: true })` OR background processing. Not directly relevant to hot-path Call inserts (one at a time), but if you write a backfill script for PacingMetric or a reconciliation script, use `createMany`.
- **Ship-when-tested.** If Gates 1/2/3 all pass, do not gate on extra approvals. Push. Move on.
- **Minimum-viable-fix.** Do not ladder up to multi-phase plans + risk registers on prototype work. If you find a bug, fix it minimally. Then move on.
- **Prefer stronger model.** Not directly relevant to this slice (you're not calling LLMs), but if you add an LLM call for any reason (e.g. call summarization), default to Claude Sonnet 4.6, not gpt-4o-mini.
- **Do not rely on Outlook auto-refresh.** Not directly relevant (you don't touch Outlook), but if you build any auth flow, plan for manual re-auth.

---

## 15. Handoff / Integration Prep

When you finish (all three gates green), the slice should be in this state:

**Code state:**
- Branch `agent-telephony` up to date with `origin/main`.
- All contract tests green in both directions, including the wire-shape assertions (event `type` discriminant, `cost` as string, `primaryPhoneE164`, `callable-now` `contactPhoneId + phone + REASON_CODES`).
- Coverage report attached: `coverage/index.html` showing 90%+ on critical paths.
- `.env.example` has every env var the slice needs, with placeholder values and comments.
- No `TODO` / `FIXME` comments on Milestone 1–5 code paths.
- No inline stubs of other agents' endpoints — only mock services under `contracts/mocks/`.
- No writes to any table outside DialSession / Call / CallLeg / PacingMetric.
- Any schema-drift proposals from §6.1 either landed via planner or clearly annotated as pending in `docs/schema-drift-pending.md`.

**Runtime state:**
- Slice boots standalone via the exact Gate-1 command above.
- Health check `GET /api/telephony/health` returns 200.
- Twilio smoke test documented in `docs/smoke-tests/telephony.md`: how Ryan verifies with a real test call before integration.

**Documentation state:**
- `src/lib/telephony/README.md` — one page overview: architecture, key files, how to run locally, how to run against real Twilio test creds.
- `docs/pacing-control-law.md` — the band table (with explicit `[low, high)` inclusivity), the AMD-FP interaction, the spend-cap interaction, the deliberate abandonment/AMD-FP double-count with FTC-rule justification, and the leg-cost accounting note (`Call.cost` = outbound leg only).
- `docs/schema-drift-pending.md` — the list of §6.1 requests, current planner status per item, and the application-level workarounds active until they land.
- `docs/wire-contract-notes.md` — a short doc capturing the §8.3 planner locks and §8.4 REASON_CODES enum, so the next executor session can see them without re-reading this brief.
- `CONTRACTS.md` updates land ONLY after planner approval per §13.

**Integration handoff:**
- At integration, `COMPLIANCE_SERVICE_BASE_URL` and `QUEUE_SERVICE_BASE_URL` get pointed at real Agent A / Agent C services. No code change should be required.
- Twilio production credentials replace test credentials. `TWILIO_CALLER_ID_NUMBER` becomes Ryan's real DID. First integration test: place ONE outbound call to Ryan's own cell from the /dialer UI. Verify ammunition panel populates. Hang up. Verify `call.completed` emitted and Agent A's activity projector wrote the Activity row.
- If loser TwiML text or MP3 URL is still pending at integration time, the session-start endpoint must refuse `method=predictive` (multi-line) sessions — power/single-line is safe because there's never a loser to drop. Add a startup check.
- **Wire-shape integration audit (5 min, mandatory before first real dial):** capture one real `call.completed` payload from `pg_notify` in prod, assert `type` field present and `cost` is string; capture one real queue response, assert `primaryPhoneE164` (not `primaryPhone`); capture one real `callable-now` response, assert `contactPhoneId` + `phone` both present and every `reasons[]` value is in `REASON_CODES`. If any assertion fails, the corresponding upstream agent has drifted from the §8.3 lock — file a §13 event and DO NOT proceed to production dialing.

**Known deferred items to flag to Ryan at handoff:**
- BLOCKING items §2 that were still unresolved.
- Any contract-change requests that went out during the build and are still pending.
- Twilio 10DLC registration status (only matters if Agent D's messaging is also going live).
- Which state's Reduced Ring Time rules Ryan wants for `ringTimeoutSec` default (19s is the Close default; FTC floor is 15s; some state AGs enforce shorter).
- Client-side leg cost not summed into `Call.cost` — MVP acceptable; revisit if spend-cap under-count exceeds 5% in practice.

---

**End of brief. Build Milestone 1a first. Do not skip ahead.**