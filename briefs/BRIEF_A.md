# Agent A Executor Brief — Core Data & Smart Views + AI Importer + Custom Fields

## Executive Summary

You are building the **Core Data slice** of `dealflow-crm`, a greenfield NYC real-estate CRM that replaces Mojo Dialer + Mojo CRM for a solo Douglas Elliman broker. This slice owns the property-centric Lead/Contact database (Close CRM data model), a Close-style **Advanced Filtering DSL** that compiles recursive JSON s_queries to parameterized SQL and evaluates Smart Views live in <500ms p95 at 25k+ rows, an **AI-driven CSV importer** (Claude Sonnet 4.6 proposes column→field mappings, auto-creates custom fields for unmapped columns), a **DealFlow signal sync** cron that pulls ranked-call ammunition from a sibling database into promoted Lead columns, and the ranked pre-scrubbed **/api/queue** endpoint that feeds the dialer.

You will build this slice **in complete isolation** for ~1–3 weeks. There are three other executors (Agents B/C/D) working in parallel worktrees on Telephony, Compliance, and Communications. You will never see their code. You will only see the frozen contracts (event payloads, HTTP shapes) they consume from you or expose to you, and you will build against **mocks** of their services for the entire build. Integration happens only after all four slices independently pass their three gates.

**BLOCKING ISSUES / DEPENDENCIES ON EXTERNAL DECISIONS:** None. Agent A can complete all three gates using only mocks of Agent C's `/api/compliance/callable-now`. You do not depend on Agent C's DNC vendor selection or Agent B's Twilio setup to reach Gate 3.

**Cross-brief consistency fixes applied to this brief** (from the cross-brief critic — bake all of these in as you build; do NOT re-litigate):

1. **Event payload discriminant unified — drop `eventName` everywhere.** Channel + LISTEN name is the routing signal. A's own emissions (`lead.upserted-from-import`, `lead.derived-signals-synced`) DO NOT carry an `eventName` field. Consumer dispatch is by pg channel + a per-listener demux table keyed on payload shape (§6).
2. **Queue field rename:** `primaryPhone` → `primaryPhoneE164` in `/api/queue` response (§7). B's contract-consumer schema uses that name; align.
3. **`call.completed.cost` wire type:** decimal-as-string (`string | null`). A's activity projector accepts a string; DO NOT coerce to `number` on ingest (§6).
4. **`/api/compliance/callable-now` response shape** (locked with planner): `{ results: [{ contactPhoneId, phone, callable, reasons, reasonDetails? }] }`. Both `contactPhoneId` AND `phone` are present. `reasons` values are drawn from the frozen `REASON_CODES` enum imported from `contracts/http/reason-codes.ts`.
5. **`/api/compliance/callable-now` batch cap** locked at 100 in `contracts/http/compliance-callable-now.json` (`contactPhoneIds.maxItems=100`). The mock enforces 413 on oversize (§7).
6. **Timezone fallback semantics — clarified.** A NEVER fabricates a timezone into the compliance call. If both `Contact.timezone` and `Lead.timezone` are null, A passes the phone to `/api/compliance/callable-now` with no fabricated timezone; C fail-closes it and A counts it under `excludedCompliance`. The display-layer fallback to `America/New_York` (used in `/api/queue` response `timezone` field and in the UI) is separate from the compliance path and does NOT enter C (§7).
7. **`Lead.source` convention locked** as A-side commitment: `"import:" + importBatchId` for importer-created leads (§9 Milestone 6). C's bulk-scrub enumeration relies on this exact prefix.
8. **D consumes `lead.upserted-from-import`.** Not a payload change, but A's brief now acknowledges D as a consumer of that channel and A does NOT filter emit-scope on consumer identity (§6).
9. **Listener robustness:** A's dispatcher IGNORES unknown payload shapes on `crm_call` (e.g., `dial-session.pacing-update` from B) without crashing (§6).
10. **`REASON_CODES` enum:** A imports and re-exports `REASON_CODES` from `contracts/http/reason-codes.ts`; A does NOT define its own vocabulary. Any `reasons` string coming back from compliance that is NOT in `REASON_CODES` is logged as a contract violation to Sentry + still treated as fail-closed for the affected phone.

---

## 1. Project Context

### Who is Ryan?
Ryan Martin — solo NYC Douglas Elliman real-estate broker, non-engineer. Single-operator. One seat. This CRM is his daily driver, replacing Mojo Dialer + Mojo CRM entirely. Non-coder means: build a working product, not a library. Ship-when-tested. Minimum-viable-fix. He pastes briefs like this into fresh Claude Code sessions.

### What is DealFlow?
`dealflow-inbox-intelligence` is Ryan's **existing** Next.js app (sibling repo to this one). It reads his Outlook inbox via Microsoft Graph, classifies emails, extracts real-estate opportunities (`ExtractedOpportunity`), and runs a matcher that pairs SELLER `MojoContact` rows with BUYER `ExtractedOpportunity` rows into `Match` rows. A nightly ranker (Brief 33) produces `CallQueueEntry` rows — the ranked list of who to call today, with an ammunition payload (priority score, top match fit, capture status, match reason).

**DealFlow stays running.** It keeps producing the smart ranking signals. The new CRM (this build) reads them via a nightly cron over a read-only Postgres role.

### The greenfield decision
Twenty, Atomic CRM, ICTCRM were all evaluated in a Phase −1 spike and rejected: real-time paradigm mismatch, AGPL contamination risk, stack impedance with DealFlow, CRUD-shape doesn't fit a WebRTC softphone. Building greenfield with Close CRM's OpenAPI spec as data-model source-of-truth.

### Sibling repo layout
```
~/…/Antigravity Projects/
  dealflow-inbox-intelligence/   ← existing app; DO NOT MODIFY
  dealflow-crm/                  ← THIS REPO; you work here
```
Same Railway Postgres server, different logical DB (`dealflow_crm`). Independent Vercel deploys.

### Stack (FROZEN — do not upgrade or swap)
Next.js 16.2.5, React 19.2.4, TypeScript 5.6+, Prisma 7.8+, PostgreSQL 16 (Railway), Tailwind 4, shadcn/ui, react-hook-form + zod, Vitest, pnpm 9, Node 22 LTS, pino, Sentry, Doppler for secrets, pg-boss for background queues, Cloudflare R2 (recordings + backups + CSV files), Anthropic SDK (Sonnet 4.6). Playwright as dev-only for M9 E2E. No Redis, no GraphQL, no Supabase.

### Empirical DealFlow findings (audit 2026-08-26 — matters for your importer + sync design)
- DealFlow's `MojoContact` table has ~7,409 real rows (mostly LLC-named NYC sellers) + 500 seed test rows. Phone 66%, email 55%, notes 68%. **Financial + property/motivation fields are 0% populated in real data.** Zapier is turned OFF; nothing new flows in there.
- **0 real BUYER_ISO opportunities.** All 163 buyer opportunities in DealFlow are seed data. The ammunition panel initially matches real sellers against seed buyers. Ryan is aware.
- `Match` table: 33,077 rows with `captureStatus` distribution (EXTERNAL_BOTH 27,282 / OWN_BUYER_ONLY 2,653 / OWN_LISTING_ONLY 2,091 / OWN_BOTH_SIDES 217). Real data.
- `CallQueueEntry`: ~50 rows per nightly generation. Real data.
- **The contact data source for the new CRM is a fresh Mojo CSV Ryan drops via your AI importer AFTER the CRM is built.** DealFlow's `MojoContact` rows are considered stale/thin/possibly-faulty for contact data. The join key between fresh Mojo CSV (this app) and DealFlow's derived signals is `mojoId` (Mojo's internal contact ID).
- **Direct consequence for /api/queue:** ~34% of imported Mojo contacts will have NO phone. Those leads are excluded from `/api/queue` entirely (see §7 rule) — the queue is a *callable* queue, not a lead list.

---

## 2. What This Slice Owns

### Tables (WRITES)
- `Organization`, `User` (tenancy — shared but you own the writes for now, single seat)
- `Lead`, `Contact`, `ContactPhone`, `ContactEmail`, `ContactUrl`
- `Opportunity`, `Task`, `Activity`
- `CustomFieldDefinition`, `CustomFieldValue`
- `SavedView`, `CustomActivityType`, `Attachment`
- `ImportBatch`
- `DealFlowDerivedSignal`
- `NotifyOverflow` (new — see §5)

### Endpoints (EXPOSES)
- CRUD:
  - `GET/POST/PUT/DELETE /api/leads`, `/api/leads/:id`
  - `GET/POST/PUT/DELETE /api/contacts`, `/api/contacts/:id`
  - `GET/POST/PUT/DELETE /api/opportunities`, `/api/opportunities/:id`
  - `GET/POST/PUT/DELETE /api/tasks`, `/api/tasks/:id`
  - `GET /api/activities`, `GET /api/leads/:id/activities` (Activities table is **append-only from event consumers** — no user-facing create/update/delete)
- Custom fields:
  - `GET/POST/PUT/DELETE /api/custom-fields` (definitions)
  - `GET/PUT /api/leads/:id/custom-values` (values)
- Smart Views:
  - `GET/POST/PUT/DELETE /api/smart-views`, `/api/smart-views/:id`
  - `POST /api/data/search` — execute an ad-hoc s_query (Close-style), returns paginated results
- Queue:
  - `GET /api/queue?viewId=<save_...>&limit=50` — pre-scrubbed, ranked, callable-now-filtered lead list for Agent B
- AI Importer:
  - `POST /api/imports` (multipart upload)
  - `GET /api/imports/:id`
  - `POST /api/imports/:id/proposed-mapping`
  - `POST /api/imports/:id/commit`
- DealFlow signal sync:
  - `GET /api/cron/dealflow-signal-sync` (bearer `CRON_SECRET`)
- Health:
  - `GET /api/core-data/health`

### Events EMITTED (LISTEN/NOTIFY)
| Event | Channel | Payload (NO `eventName` discriminant — routing is channel + shape) |
|---|---|---|
| `lead.upserted-from-import` | `crm_lead_sync` | `{ leadId, sourceLabel, importBatchId, correlationId }` |
| `lead.derived-signals-synced` | `crm_lead_sync` | `{ count, syncedAt, correlationId }` |

### Events CONSUMED (LISTEN)
| Event | Channel | Emitter | Your reaction |
|---|---|---|---|
| `call.connected` | `crm_call` | B | Append `Activity` row (type='Call', status=in-progress); hydrate ammunition payload (join Lead + DealFlowDerivedSignal) for SSE bridge |
| `call.completed` | `crm_call` | B | Update `Activity` row with disposition, duration, `cost` (string decimal — DO NOT coerce), append note if provided |
| `dial-session.pacing-update` | `crm_call` | B | IGNORE. Dispatcher recognizes shape, logs a debug line, and returns. Not A's concern (Ops dashboard) but the listener MUST NOT crash. |
| `message.received` | `crm_message` | D | Append `Activity` row (type='Email' or 'SMS'); upsert `EmailThread` cross-reference if channel=email (READ side — you do NOT own EmailThread writes; D owns that table but emits the event; you append the Activity that references it). Payload has NO `eventName` field. |
| `scrub.completed` | `crm_scrub` | C | See §6 — handler is deleted; compliance is enforced inline in `/api/queue`. This event is a no-op logger for observability only. |

Every payload carries a `correlationId` (uuid v4) for pino tracing.

---

## 3. What This Slice Does NOT Touch

### Tables you MUST NOT write to
- `DialSession`, `Call`, `CallLeg`, `PacingMetric` (Agent B owns — you may SELECT to build activity timelines, but you MUST NOT INSERT/UPDATE)
- `DncSuppression`, `LitigatorSuppression`, `MobileLineCache`, `CallingWindowConfig`, `HolidaySuppressionDate`, `ScrubLog` (Agent C owns — do NOT SELECT from these tables in your queue path; use the `/api/compliance/callable-now` endpoint instead)
- `Message`, `EmailThread`, `MessageTemplate`, `Sequence`, `SequenceStep`, `SequenceEnrollment` (Agent D owns)
- `OAuthCredential` (D-owned, pending planner ratification — do not add to A's migration; D will ship the migration for it once planner confirms).

### Endpoints you MUST NOT hit directly (use mocks in build; real ones at integration)
- `POST /api/telephony/*` — B
- `POST /api/compliance/scrub` — C (you don't call this; it's for other slices)
- `POST /api/compliance/callable-now` — C (you DO call this from `/api/queue` on every request — see §7 — through a mock during the entire build)
- `POST /api/compliance/dnc/internal` — C (D calls this on STOP; A does not)
- `GET /api/comms/threads` — D

### Never
- Send email, SMS, or place a call. That's B and D.
- Query DNC vendors or line-type vendors directly. That's C.
- Modify DealFlow's DB. `DATABASE_URL_DEALFLOW_RO` is **read-only**; the Postgres role has no write grants. Assume writes will fail; don't try.
- Fabricate a timezone into a compliance call. If tz is unknown, pass it through as-is and let C fail-closed (§7).

---

## 4. Environment / Secrets

All secrets injected via Doppler at runtime. Repo has `.env.example` only. Never commit real secrets.

**You need (repo `.env.example` should list):**
- `DATABASE_URL_MAIN` — Postgres for `dealflow_crm` DB on Railway
- `DATABASE_URL_DEALFLOW_RO` — read-only role into DealFlow's `railway` DB (Ryan will provision the role; use a placeholder in `.env.example`)
- `DATABASE_URL_PERF` — dedicated `dealflow_crm_perf` Postgres DB for the 25k perf seed (URL suffix MUST end in `_perf` — the seed and perf scripts refuse to run against any other DB). Ryan provisions.
- `CRON_SECRET` — bearer token for `/api/cron/*` endpoints
- `SENTRY_DSN` — Sentry project DSN
- `SENTRY_ENVIRONMENT` — dev/staging/prod
- `ANTHROPIC_API_KEY` — Claude Sonnet 4.6 for importer AI column mapping
- `ANTHROPIC_MODEL` — model ID to be locked at Milestone 6 kickoff. **You MUST invoke the `claude-api` skill at start of Milestone 6 to get the exact current model string** (Ryan's memory: model IDs drift; never hardcode from training data). Provisional placeholder in `.env.example`: `claude-sonnet-4-6`.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_IMPORTS` — Cloudflare R2 for raw CSV storage
- `COMPLIANCE_BASE_URL` — where to call Agent C's `/api/compliance/callable-now` (during build: mock server; at integration: real service)
- `COMPLIANCE_CALLABLE_BATCH_SIZE` — batch size for `/api/compliance/callable-now`. Default `100`. HARD MAX `100` (enforced by contract JSON schema `contactPhoneIds.maxItems=100`; any attempt to raise this locally must fail loudly). Increasing above 100 requires a contract change.
- `DEALFLOW_SYNC_STUB` — set to `1` during isolated build to route the DealFlow sync at a docker fixture instead of a live RO DB. Unset (or `0`) in production.

**TBD / not blocking you:**
- Doppler project name — use `.env.local` sourced from Doppler dev config; Ryan will finalize the Doppler project structure at integration.

---

## 5. Complete Prisma Schema

**Rule:** paste the FULL Phase-0 schema (all four slices' tables) verbatim into `prisma/schema.prisma`. This brief provides Agent A's tables in full below; B/C/D's tables are frozen in the shared context (§3 of the shared context that Ryan pastes with this brief). Copy them verbatim from that shared context. If the shared context and this brief diverge on any field of A's tables, this brief wins for A's tables; for B/C/D tables, the shared context wins.

**Rule:** additive-only during parallel builds. Every migration is a new file. If you discover a needed change to a B/C/D table, STOP and message the planner. Do NOT modify B/C/D field names, types, or indexes in your working copy — that's a contract change routed through the planner. In particular:
- `OAuthCredential` (D) — pending planner ratification. Do NOT add to A's migration. If D's migration lands later, `git pull` and `pnpm prisma generate` picks it up.
- `BulkScrubCheckpoint` (C) — pending planner ratification. Same rule.
- `Call.emittedAt` (B) — pending planner ratification. Same rule.

The full Prisma schema for Agent A's owned tables (verbatim — do not modify field names, types, or indexes without a contract change):

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL_MAIN") }

// ── Tenancy ────────────────────────────────────────────────────────
model Organization {
  id String @id @default(cuid())
  slug String @unique
  name String
  createdAt DateTime @default(now())
  users User[]; leads Lead[]; contacts Contact[]; dialSessions DialSession[]
  scrubLogs ScrubLog[]; messages Message[]; savedViews SavedView[]
}
model User {
  id String @id @default(cuid())
  organizationId String
  email String @unique
  displayName String
  createdAt DateTime @default(now())
  organization Organization @relation(fields: [organizationId], references: [id])
  activities Activity[]; calls Call[]; dialSessions DialSession[]
  @@index([organizationId])
}

// ── Agent A — Core Data (owns writes) ──────────────────────────────
model Lead {
  id String @id @default(cuid())
  organizationId String
  displayName String
  name String?
  description String?
  source String?                 // "import:<importBatchId>" for importer-created leads; other producers may set free-form
  statusId String?
  statusLabel String?
  url String?
  addresses Json @default("[]")
  primaryAddressFull String?
  primaryAddressSummary String?
  timezone String?
  localtime String?

  priorityScore Int?
  topMatchFit Int?
  captureStatus String?
  matchReason String?
  dealflowDeepLink String?

  mojoId String? @unique
  dealflowSignalSyncedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])
  contacts Contact[]; opportunities Opportunity[]; tasks Task[]; activities Activity[]
  customValues CustomFieldValue[]

  @@index([organizationId])
  @@index([organizationId, priorityScore(sort: Desc)])
  @@index([organizationId, statusId])
  @@index([mojoId])
  @@index([source])   // supports C's bulk-scrub enumeration on "import:<id>" prefix
}
model Contact {
  id String @id @default(cuid())
  organizationId String
  leadId String
  displayName String
  name String?
  title String?
  timezone String?
  timezoneSource String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  organization Organization @relation(fields: [organizationId], references: [id])
  lead Lead @relation(fields: [leadId], references: [id], onDelete: Cascade)
  phones ContactPhone[]; emails ContactEmail[]; urls ContactUrl[]; activities Activity[]
  @@index([organizationId])
  @@index([leadId])
}
model ContactPhone {
  id String @id @default(cuid())
  contactId String
  phone String
  phoneFormatted String?
  type String
  country String?
  outboundSmsBlocked Boolean @default(false)
  isPrimary Boolean @default(false)
  lineType String?
  lineTypeVerifiedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  @@index([contactId])
  @@index([phone])
  @@unique([contactId, phone])
}
model ContactEmail {
  id String @id @default(cuid())
  contactId String
  email String
  type String
  isUnsubscribed Boolean @default(false)
  isPrimary Boolean @default(false)
  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  @@index([contactId])
  @@unique([contactId, email])
}
model ContactUrl {
  id String @id @default(cuid())
  contactId String
  type String
  url String
  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  @@index([contactId])
}
model Opportunity {
  id String @id @default(cuid())
  organizationId String
  leadId String
  contactId String?
  pipelineId String?
  statusId String?
  statusLabel String?
  statusType String
  confidence Int @default(0)
  value Int?
  valuePeriod String @default("one_time")
  valueCurrency String @default("USD")
  note String?
  dateWon DateTime?
  dateLost DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  lead Lead @relation(fields: [leadId], references: [id], onDelete: Cascade)
  @@index([organizationId])
  @@index([leadId])
}
model Task {
  id String @id @default(cuid())
  organizationId String
  leadId String?
  contactId String?
  type String
  text String
  dueDate DateTime?
  isDateless Boolean @default(false)
  isComplete Boolean @default(false)
  completedAt DateTime?
  assignedToId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  lead Lead? @relation(fields: [leadId], references: [id], onDelete: SetNull)
  @@index([organizationId])
  @@index([assignedToId, isComplete, dueDate])
}
model Activity {
  id String @id @default(cuid())
  organizationId String
  leadId String?
  contactId String?
  userId String?
  type String
  activityAt DateTime
  dateCreated DateTime @default(now())
  callId String?
  messageId String?
  taskId String?
  bodyText String?
  bodyHtml String?
  lead Lead? @relation(fields: [leadId], references: [id], onDelete: SetNull)
  contact Contact? @relation(fields: [contactId], references: [id], onDelete: SetNull)
  user User? @relation(fields: [userId], references: [id], onDelete: SetNull)
  @@index([organizationId, activityAt(sort: Desc)])
  @@index([leadId, activityAt(sort: Desc)])
  @@index([contactId, activityAt(sort: Desc)])
}
model CustomFieldDefinition {
  id String @id @default(dbgenerated("'cf_' || substr(md5(random()::text), 1, 24)"))
  organizationId String
  objectType String
  name String
  description String?
  type String
  choices String[] @default([])
  acceptsMultipleValues Boolean @default(false)
  displayOrder Int
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  values CustomFieldValue[]
  @@index([organizationId, objectType, displayOrder])
  @@unique([organizationId, objectType, name])
}
model CustomFieldValue {
  id String @id @default(cuid())
  organizationId String
  definitionId String
  objectType String
  objectId String
  valueText String?
  valueNumber Float?
  valueDate DateTime?
  valueJson Json?
  definition CustomFieldDefinition @relation(fields: [definitionId], references: [id], onDelete: Cascade)
  lead Lead? @relation(fields: [objectId], references: [id], onDelete: Cascade, map: "cfv_lead_fk")
  @@index([organizationId, objectType, objectId])
  @@index([definitionId])
  @@unique([definitionId, objectId])
}
model SavedView {
  id String @id @default(dbgenerated("'save_' || substr(md5(random()::text), 1, 24)"))
  organizationId String
  userId String?
  name String
  description String?
  type String
  sQuery Json
  selectedFields Json @default("[]")
  sort Json @default("[]")
  resultsLimit Int?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  organization Organization @relation(fields: [organizationId], references: [id])
  @@index([organizationId, type])
}
model CustomActivityType {
  id String @id @default(cuid())
  organizationId String
  name String
  namePlural String
  createdAt DateTime @default(now())
  @@unique([organizationId, name])
}
model Attachment {
  id String @id @default(cuid())
  organizationId String
  filename String
  mimeType String
  sizeBytes Int
  storageKey String
  createdAt DateTime @default(now())
  @@index([organizationId])
}
model ImportBatch {
  id String @id @default(cuid())
  organizationId String
  userId String
  sourceLabel String
  filename String
  storageKey String
  status String @default("pending")
  mappingJson Json?
  totalRows Int @default(0)
  importedRows Int @default(0)
  duplicateRows Int @default(0)
  skippedRows Int @default(0)
  errorRows Int @default(0)
  errorLog Json @default("[]")
  createdAt DateTime @default(now())
  completedAt DateTime?
  @@index([organizationId, createdAt(sort: Desc)])
}
model DealFlowDerivedSignal {
  id String @id @default(cuid())
  organizationId String
  mojoId String @unique
  queueRank Int?
  priorityScore Int?
  queueReason String?
  primaryMatchId String?
  primaryMatchFit Int?
  primaryCaptureStatus String?
  primaryMatchConfidence String?
  syncedAt DateTime @default(now())
  dealflowRawJson Json
  @@index([organizationId, priorityScore(sort: Desc)])
  @@index([syncedAt])
}
model NotifyOverflow {
  id String @id @default(cuid())
  channel String
  payload Json
  createdAt DateTime @default(now())
  consumedAt DateTime?
  @@index([channel, createdAt])
}
```

**Why `NotifyOverflow` is in the schema now:** Postgres NOTIFY payloads are capped at 8000 bytes. Any handler that emits >8kb serializes the full payload into `NotifyOverflow`, then emits `{ ..., overflow: true, overflowId }` on the wire. Committing to the table now (rather than "add if needed") avoids a mid-build migration and unblocks the emit helper design.

**Why `Lead.source` gets an index:** Agent C enumerates leads-by-import via `Lead.source LIKE 'import:%'` for bulk-scrub. That's an A-side commitment (§9 Milestone 6). The btree index on `source` keeps that enumeration fast at 25k+ rows.

**Include the B/C/D tables verbatim** from the shared context in your `prisma/schema.prisma` so Prisma generates cleanly. Treat those types as read-only in your code. B/C/D own their migrations for those tables; you own the initial migration that creates them so `prisma migrate dev` works standalone.

---

## 6. Event Catalog for This Slice

### Channels (PostgreSQL LISTEN/NOTIFY)
- `crm_call` — call.connected, call.completed, dial-session.pacing-update (ignored by A)
- `crm_message` — message.received
- `crm_scrub` — scrub.completed
- `crm_lead_sync` — lead.upserted-from-import, lead.derived-signals-synced

### Convention — NO `eventName` discriminant in payloads
Per cross-brief lock-down: routing is done by `(channel, payload-shape)`. A's dispatcher for each channel keeps a small demux table:

```ts
// pseudocode
demux[channel='crm_call'] = [
  { predicate: p => 'callId' in p && 'connectedAt' in p,   handler: onCallConnected },
  { predicate: p => 'callId' in p && 'disposition' in p,   handler: onCallCompleted },
  { predicate: p => 'dialSessionId' in p && 'currentLineCount' in p, handler: () => log.debug('pacing update ignored') },
];
demux[channel='crm_message'] = [
  { predicate: p => 'messageId' in p && 'channel' in p,    handler: onMessageReceived },
];
demux[channel='crm_scrub'] = [
  { predicate: p => 'phoneCount' in p && 'blockedCount' in p, handler: onScrubCompletedLog },
];
```

If NO predicate matches, log `unknown-payload-shape` at info-level with the correlationId and payload keys (values redacted), and return. NEVER crash the listener.

### Events YOU EMIT

**`lead.upserted-from-import`** (channel `crm_lead_sync`) — during importer commit, one per row upserted.
```ts
{
  leadId: string,           // cuid
  sourceLabel: string,      // free-form from ImportBatch.sourceLabel
  importBatchId: string,
  correlationId: string     // uuid v4, propagated from HTTP request
}
```

**`lead.derived-signals-synced`** (channel `crm_lead_sync`) — after the DealFlow signal sync cron completes.
```ts
{
  count: number,            // total DealFlowDerivedSignal rows upserted this run
  syncedAt: string,         // ISO 8601 UTC
  correlationId: string
}
```

Consumers on `crm_lead_sync`:
- A itself: activity projector uses `lead.upserted-from-import` for internal audit signals.
- D: subscribes to `lead.upserted-from-import` to trigger thread reconcile (per D's brief §8). This is documented here so the contract catalog stays truthful; A does NOT change emit scope or filter based on consumer identity.

**Emission rules:**
- Emit in the SAME transaction as the state change (Postgres NOTIFY is transactional — it fires on commit).
- Payload is JSON stringified, no trailing whitespace, NO `eventName` field.
- If NOTIFY payload > 7500 bytes (safe margin under Postgres's 8000 cap), insert into `NotifyOverflow` first, then emit `{ overflow: true, overflowId, correlationId }`. Consumers on this side re-fetch by `overflowId`.

### Events YOU CONSUME

**`call.connected`** (channel `crm_call`, emitter B):
```ts
{ callId, dialSessionId, leadId, contactId, remotePhone, connectedAt /* ISO */, correlationId }
```
Reaction: INSERT `Activity` row: `type='Call'`, `callId`, `activityAt=connectedAt`, `leadId`, `contactId`, `bodyText='Call in progress'`. Then hydrate ammunition (SELECT Lead + DealFlowDerivedSignal join) and hand the payload to the SSE bridge (via a pg NOTIFY on your own channel `crm_ui` — the SSE bridge is planner-scaffolded and listens broadly; you just push the enriched payload).

**`call.completed`** (channel `crm_call`, emitter B):
```ts
{
  callId: string,
  disposition: string,
  duration: number,
  cost: string | null,      // decimal-as-string per B's wire type; DO NOT coerce to number
  outcomeId?: string,
  correlationId: string
}
```
Reaction: UPDATE `Activity` where `callId=callId` — set disposition-derived `bodyText`, complete state. Store `cost` as the received string in `Activity.bodyText` metadata JSON or a dedicated column if added later; never `Number(cost)` at the ingest boundary. If no Activity exists yet (call.completed arrived before call.connected — theoretically impossible but handle it), INSERT one.

**`dial-session.pacing-update`** (channel `crm_call`, emitter B): IGNORE. Log-and-return. Not A's job.

**`message.received`** (channel `crm_message`, emitter D):
```ts
{ messageId, channel, contactId?, leadId?, correlationId }
```
Reaction: SELECT the Message row (D writes it before emitting), INSERT `Activity` with `type='Email'` or `'SMS'`, `messageId`, `activityAt=Message.activityAt`, `bodyText=Message.bodyText`, `bodyHtml=Message.bodyHtml`.

**`scrub.completed`** (channel `crm_scrub`, emitter C): **HANDLER DELETED per review.** Payload as documented in shared context has no phone list, so there's no principled reaction from A. Compliance is enforced inline by `/api/queue` calling `/api/compliance/callable-now` (see §7 rule). The listener STILL subscribes to this channel but its ONLY action is a pino info log `"scrub.completed observed"` with the correlationId for observability. No Lead writes. No `ScrubLog` reads across ownership. If planner later amends the payload to include `blockedPhoneIds: string[]`, revisit — but not in this build.

**Consumer design:**
- One long-lived pg client per channel, connected via a dedicated `LISTEN` pool separate from Prisma's main pool.
- `pg-boss` handles retries for downstream side effects. Each event handler wraps its work in a pg-boss job for idempotent retry semantics.
- **Idempotency key format (verified distinct, no reliance on `eventName` — key is derived from channel + payload-identity):**
  - `call.connected` → `crm_call:connected:${callId}`
  - `call.completed` → `crm_call:completed:${callId}`
  - `message.received` → `crm_message:received:${messageId}`
  - `scrub.completed` → `crm_scrub:completed:${correlationId}` (observability only)
- Handlers must be idempotent: dup-emission tests are part of Gate 3.

---

## 7. HTTP Contracts for This Slice

Every request/response carries `x-correlation-id`. If the client omits it, generate one and echo it back.

### Primacy / selection rules (used by /api/queue and lead detail)

When a Lead has multiple Contacts, phones, or emails, "primary" is determined by these **exact deterministic rules** (bake into `queue-service.ts` and lead detail):

- **Primary Contact** = the Contact with lowest `createdAt` for that Lead (ties broken by `id` ascending).
- **Primary ContactPhone** = the ContactPhone (of the primary Contact) with `isPrimary = true`; if none, the ContactPhone with lowest `createdAt` (ties broken by `id`).
- **Primary ContactEmail** = same rule as phone.
- **Effective displayName** = `Lead.displayName` (not the Contact's displayName).

**Effective timezone — SPLIT SEMANTICS (per cross-brief clarification):**
- For the `/api/queue` response's `timezone` field (display / UI hint): `Contact.timezone ?? Lead.timezone ?? 'America/New_York'`.
- For the payload sent to `/api/compliance/callable-now`: pass `Contact.timezone ?? Lead.timezone` with NO fabricated fallback. If both are null, the field is omitted (or null) in the compliance request. Agent C will fail-closed with reason `timezone_unresolved`; that phone is then counted in `excludedCompliance`. This preserves C's stance ("no fabricated timezones enter compliance") while still giving the UI a reasonable render string.

### Exposed by A

**GET /api/queue?viewId=<save_...>&limit=50**
Purpose: Agent B calls this to get the ranked, pre-scrubbed lead list.
Query params: `viewId` (required), `limit` (default 50, max 200).
Response:
```ts
{
  view: { id: string, name: string },
  leads: [{
    leadId: string,
    contactId: string,                // primary Contact id; guaranteed non-null
    primaryPhoneId: string,           // primary ContactPhone id; guaranteed non-null
    primaryPhoneE164: string,         // E.164; guaranteed non-null  (renamed from primaryPhone to match B's schema)
    displayName: string,              // Lead.displayName
    primaryAddressSummary: string|null,
    timezone: string,                 // IANA; display-fallback rule ('America/New_York' if unknown)
    ammunition: {
      priorityScore: number|null,
      topMatchFit: number|null,
      captureStatus: string|null,
      matchReason: string|null,
      dealflowDeepLink: string|null
    }
  }],
  excludedNoPhone: number,            // count of candidate leads dropped because no primary phone existed
  excludedCompliance: number,         // count of candidate leads dropped by fail-closed compliance check
  generatedAt: string,                // ISO
  stale: boolean,                     // true if any of: DealFlow signals >24h old, compliance service unavailable
  staleReason?: string                // e.g. "DealFlow signals last synced 32h ago" or "Compliance service unavailable"
}
```

Note: B's consumed schema (per its own brief) may subset-parse this response and only key on `leadId`, `contactId`, `primaryPhoneId`, `primaryPhoneE164`, `ammunition`. That's fine — extra fields are additive. Contract tests on A's side assert BOTH the shape AND the additional-field contract (`excludedNoPhone`, `excludedCompliance`, `stale`, `staleReason`, `displayName`, `timezone`) so that B can subscribe to them later.

**MANDATORY BEHAVIOR (unambiguous — pre-scrub applies unconditionally):**

1. Load SavedView by `viewId`; validate `type=lead`. 404 if not found.
2. Compile `sQuery` → SQL via the query DSL (Milestone 1). Execute against `Lead` + joins.
3. For every candidate lead, resolve primary Contact + primary ContactPhone using the rules above. **Any lead where a primary ContactPhone cannot be resolved is EXCLUDED from the response and counted in `excludedNoPhone`.** This is not optional — it applies regardless of what the SavedView's sQuery says.
4. **ALWAYS call `POST /api/compliance/callable-now`** with the primary ContactPhone ids of all surviving candidates, batched at `COMPLIANCE_CALLABLE_BATCH_SIZE` (default 100, hard-capped at 100 by contract JSON schema). Each batch entry sends `{ contactPhoneId, phone, timezone? }`. Timezone is included only if non-null per the split-semantics rule above. This is unconditional — the `callable_now` `field_condition` in a SavedView's sQuery is orthogonal; the queue endpoint applies compliance to every lead every time regardless of whether the view has that predicate. Rationale: the safety rule is that no lead exits `/api/queue` un-scrubbed; a mis-authored SavedView must not be the load-bearing safety check.
5. Match `results` back to leads by `contactPhoneId` (the primary key of the join) OR by `phone` (secondary key, used only if `contactPhoneId` missing from the response — logged as contract drift). Fail-closed: if compliance returns 5xx/timeout/malformed, treat ALL phones in the failed batch as `callable:false`. Also treat as `callable:false` any phone that comes back with `reasons` containing values NOT in `REASON_CODES` (log contract violation). Those leads are EXCLUDED from the response and counted in `excludedCompliance`. Set `stale=true`, `staleReason="Compliance service unavailable"` (only for connectivity-class failures — malformed enum values do not set `stale`). Sentry alert.
6. Sort the remaining leads by SavedView's `sort` (default `[{ field: "priorityScore", direction: "desc" }]`, NULLS LAST).
7. Return top `limit`.

Note: fields marked "guaranteed non-null" in the response type reflect that leads without a phone are excluded upstream in step 3, so no null shape reaches Agent B. Contract tests assert both the shape AND the exclusion semantics.

**POST /api/imports** (multipart/form-data)
Body: `file` (CSV or XLSX, max 100MB), `sourceLabel` (string).
Response: `{ importBatchId, status: 'pending' }`.
Behavior: stream to R2 at key `imports/<orgId>/<importBatchId>/<filename>`. Create ImportBatch row with `status='pending'`, `totalRows` unset until commit.

**GET /api/imports/:id**
Response: full ImportBatch row + progress metrics.

**POST /api/imports/:id/proposed-mapping**
Body: `{}` (idempotent trigger).
Response:
```ts
{
  mapping: [{
    column: string,               // "Est Value"
    sampleValues: string[],       // first 5 non-null samples
    target: {
      kind: "standard_field",
      field: "Lead.name" | "Lead.primaryAddressFull" | "Lead.mojoId" |
             "ContactPhone.phone" | "ContactPhone.type" |
             "ContactEmail.email" | "Contact.title" | "Contact.name" | ...
    } | {
      kind: "new_custom_field",
      name: string,
      type: "text"|"number"|"date"|"datetime"|"url"|"email"|"choices",
      choices?: string[]
    } | {
      kind: "existing_custom_field",
      definitionId: string
    } | {
      kind: "ignore"
    },
    confidence: number,           // 0-1
    reasoning: string             // "Header 'Estimated Value' + samples ($100K-$2M) match a numeric price field"
  }],
  likelyDuplicates: [{
    columnA: string, columnB: string, reason: string
  }],
  headerRow: string[],
  totalRowsDetected: number
}
```
Behavior:
1. Read raw file from R2. Parse header + first 20 sample rows using `papaparse` (CSV) or `xlsx` (Excel).
2. Build prompt for Claude Sonnet 4.6 (system + user; see §9 Milestone 6).
3. Call Anthropic API with response format = JSON. Retry once on transient error. On second failure return 503.
4. Store proposal in `ImportBatch.mappingJson`. Set `status='mapping_review'`.
5. Return proposal.

**POST /api/imports/:id/commit**
Body: `{ mapping: <same shape as proposed>, duplicateStrategy: "skip"|"merge"|"add-anyway" }`.
Response: `{ status: 'importing' }` immediately (202 Accepted); actual work is a pg-boss job.
Behavior: same as before — persist confirmed mapping, create CustomFieldDefinitions, enqueue pg-boss `import.commit`, worker streams CSV row-by-row, upserts, dedups, emits `lead.upserted-from-import`, updates counters, and sets `Lead.source = "import:" + importBatchId` on every upsert (locked A-side commitment for C's bulk-scrub). Full detail in §9 Milestone 6.

**GET /api/cron/dealflow-signal-sync** (bearer `CRON_SECRET`) — as before; full detail in §9 Milestone 5.

**GET /api/leads/:id** (detail render)
Response includes: standard fields + `customFields: [{ definitionId, name, type, displayOrder, value }]` for only-populated custom values. Never include null-value custom fields.

**POST /api/data/search** (Close-style ad-hoc s_query) — as before, paginated with opaque cursor.

**GET /api/core-data/health**
Response: `{ status: "ok"|"degraded"|"down", checks: { db: ok, dealflowRo: ok|"stale", anthropic: ok, r2: ok }, timestamp }`.

### Consumed by A (through mocks during build)

**POST /api/compliance/callable-now** (Agent C — mocked at `contracts/mocks/compliance/`)

Request:
```ts
{
  contactPhoneIds: string[],   // max 100 (schema-enforced)
  entries?: Array<{ contactPhoneId: string, phone: string, timezone?: string }>,  // optional richer entry list; if provided, contactPhoneIds MUST match and length must be equal
  atInstant?: string           // ISO
}
```

- **Batch size cap is a locked contract**: max 100 ids per request, enforced by `contracts/http/compliance-callable-now.json` (`contactPhoneIds.maxItems=100`). `COMPLIANCE_CALLABLE_BATCH_SIZE` env is available for tuning DOWN but MUST NOT exceed 100. The mock rejects requests >100 with HTTP 413 so contract tests catch violations locally.
- If planner later raises the cap, the JSON schema gets a version bump and both A and C re-pull.

Response (locked shape):
```ts
{
  results: [{
    contactPhoneId: string,        // matches request entry
    phone: string,                 // E.164 (echoed back for cross-check)
    callable: boolean,
    reasons: string[],             // values MUST be drawn from REASON_CODES enum
    reasonDetails?: Record<string, unknown>  // optional; C-owned; A logs but does not gate on
  }]
}
```

**Fail-closed:** on 5xx, timeout, malformed response, missing entry for a submitted phone id, OR any `reasons` value outside `REASON_CODES` — treat that phone as `callable:false`. Contract-violation reasons ALSO log a Sentry warning ("compliance returned unknown REASON_CODE") but do not block the run.

`REASON_CODES` is imported from `contracts/http/reason-codes.ts` (planner-published). A does NOT define its own enum locally. Current locked values (per Brief C §7A) include, at minimum: `internal_dnc`, `federal_dnc`, `state_dnc`, `litigator`, `outside_calling_window_hour`, `outside_calling_window_dow`, `holiday_suppression`, `timezone_unresolved`, `mobile_line_blocked`. If your `REASON_CODES` import doesn't include `timezone_unresolved`, STOP and message the planner — that's the fallback code A relies on for the split-semantics timezone rule.

---

## 8. Repository Layout + Worktree Setup

### One-time setup (Ryan runs, then hands you the worktree)

```bash
cd ~/…/Antigravity\ Projects/dealflow-crm
git worktree add worktrees/agent-a agent-a
cd worktrees/agent-a
pnpm install
```

### Your working directory
`~/…/Antigravity Projects/dealflow-crm/worktrees/agent-a` — use absolute paths, do not `cd` around.

### iCloud landmine (Ryan-specific)
The parent repo lives in iCloud Drive. iCloud sometimes creates duplicate files with a space + digit suffix (e.g. `file 2.ts`, `file 2.tsx`). Before commits, run:
```bash
find src -regex '.*\s2\.\(tsx\|ts\|json\)' -not -path '*/node_modules/*'
```
If any hits: `rm` them. Do NOT trust grep audits that don't explicitly filter these.

### Directory layout you'll create
```
src/
├── app/                                # Next.js App Router
│   ├── api/
│   │   ├── leads/[...]
│   │   ├── contacts/[...]
│   │   ├── opportunities/[...]
│   │   ├── tasks/[...]
│   │   ├── activities/[...]
│   │   ├── custom-fields/[...]
│   │   ├── smart-views/[...]
│   │   ├── data/search/route.ts
│   │   ├── queue/route.ts
│   │   ├── imports/[...]
│   │   ├── cron/dealflow-signal-sync/route.ts
│   │   └── core-data/health/route.ts
│   ├── leads/                          # UI mount point
│   ├── queue/                          # UI mount point (list preview only; Agent B owns dialer UI)
│   └── imports/                        # UI mount point (upload + mapping review)
├── lib/
│   ├── core-data/
│   │   ├── query-dsl/
│   │   │   ├── schema.ts
│   │   │   ├── compiler.ts
│   │   │   ├── executor.ts
│   │   │   └── compliance-bridge.ts
│   │   ├── importer/
│   │   │   ├── upload.ts
│   │   │   ├── parser.ts
│   │   │   ├── ai-mapping.ts
│   │   │   ├── commit-worker.ts
│   │   │   └── dedup.ts
│   │   ├── dealflow-sync/
│   │   │   ├── ro-client.ts
│   │   │   ├── sync.ts
│   │   │   └── promote.ts
│   │   ├── events/
│   │   │   ├── emit.ts
│   │   │   ├── listen.ts
│   │   │   ├── demux.ts                 # shape-based dispatcher (no eventName discriminant)
│   │   │   └── handlers/
│   │   │       ├── call-connected.ts
│   │   │       ├── call-completed.ts
│   │   │       ├── message-received.ts
│   │   │       └── scrub-completed.ts   # no-op observability logger
│   │   └── smart-view/
│   │       └── queue-service.ts         # composes DSL + primacy resolution + compliance + sort
│   └── shared/
│       ├── prisma.ts
│       ├── logger.ts
│       ├── sentry.ts
│       ├── auth.ts
│       ├── correlation.ts
│       └── reason-codes.ts              # re-exports contracts/http/reason-codes.ts
├── types/
prisma/
├── schema.prisma
├── migrations/
└── seed.ts
scripts/
├── perf-25k.ts
├── restore-from-backup.ts
├── boot-standalone.ts
└── seed-dev.ts
contracts/
├── mocks/
│   ├── compliance/                     # Fastify mock for /api/compliance/callable-now
│   └── dealflow-ro/                    # docker-compose + fixture.sql for RO sync tests
tests/
├── unit/
├── contract/
├── perf/
├── e2e/                                # Playwright — UI acceptance (Milestone 9)
└── integration-local/
```

### Bootstrapping
```bash
cp .env.example .env.local
pnpm prisma migrate dev --name initial
pnpm prisma generate
pnpm tsc --noEmit
pnpm vitest run
```

**Ryan-specific reminders (do not skip):**
- `import 'dotenv/config'` MUST be the first import of every script that touches DB. If you forget, Prisma silently defaults to `localhost:5432` and fails mysteriously.
- Run `pnpm prisma generate` between `migrate dev` and `pnpm tsc` — else stale types mask real errors.
- Prisma sequential `.create()` against Railway ≈ 90ms/row over network. Bulk writes >100 rows use `createMany({ skipDuplicates: true })` OR background via pg-boss.

---

## 9. Milestones + Implementation Plan

Work strictly in order. Do not skip forward. Each milestone has a checkpoint you cannot leave until it's green.

### Milestone 1 — Advanced Filtering DSL compiler + 25k-row perf harness (FRONT-LOADED)
**Why first:** this is the highest architectural-risk piece. If the DSL can't hit <500ms p95 at 25k rows, everything downstream (Smart Views, /api/queue, dialer feed) is compromised.

**Files:**
- `src/lib/core-data/query-dsl/schema.ts` — zod schema for the recursive tree.
- `src/lib/core-data/query-dsl/compiler.ts` — pure function: `compile(sQuery, context) → { sql: string, params: unknown[] }`.
- `src/lib/core-data/query-dsl/executor.ts` — `execute(compiled, prisma) → rows[]`.
- `scripts/seed-dev.ts` — creates 1 org, 1 user, 25,000 Lead rows (varied statusLabel, priorityScore, addresses with mixed timezones, ~half with mojoId, ~66% with a Contact + ContactPhone to mirror empirical DealFlow phone-coverage).
- `scripts/perf-25k.ts` — runs 20 realistic queries against the 25k seed, records p50/p95/p99, asserts p95 <500ms.

**s_query node types you MUST support:**
```ts
type SQuery =
  | { type: "and", queries: SQuery[] }
  | { type: "or", queries: SQuery[] }
  | { type: "match_all" }
  | { type: "object_type", object_type: "lead"|"contact"|"opportunity"|"activity" }
  | { type: "field_condition", field: FieldRef, condition: Condition }
  | { type: "has_related", object_type: string, query: SQuery };

type FieldRef =
  | { kind: "regular", table: string, column: string }
  | { kind: "custom", definitionId: string }
  | { kind: "compliance", predicate: "callable_now"|"dnc_clean" };

type Condition =
  | { type: "text", mode: "full_words"|"exact"|"contains", value: string }
  | { type: "number", op: "gt"|"lt"|"gte"|"lte"|"eq", value: number }
  | { type: "number", op: "in", values: number[] }
  | { type: "date", op: "before"|"after", value: string /* ISO */ }
  | { type: "date", op: "between", from: string, to: string }
  | { type: "term", op: "in", values: string[] };
```

**Compiler rules:**
- All parameters use `$1, $2, ...` placeholders — NEVER string-interpolate values.
- Custom field access joins `CustomFieldValue cfv ON cfv.object_id = Lead.id AND cfv.definition_id = $N`; access `cfv.value_number` / `value_text` / `value_date` based on definition's type.
- Compliance predicates in an sQuery are extracted BEFORE SQL emission and evaluated post-fetch via `/api/compliance/callable-now`. (Note: `/api/queue` ALWAYS applies compliance regardless; a sQuery `callable_now` predicate is redundant on that path but supported for `/api/data/search` ad-hoc queries.)
- Sorting by `priorityScore` maps to `Lead.priorityScore` (promoted column). Compiler emits `ORDER BY lead.priority_score DESC NULLS LAST`.
- Nested and/or with 4-level depth must compile without stack issues.

**Perf targets:**
- Seed set: 25,000 Lead + ~30,000 Contact + ~40,000 ContactPhone + 10 CustomFieldDefinition + ~50,000 CustomFieldValue.
- 20 test queries. p95 <500ms, p99 <1000ms.
- Run on the **dedicated perf DB** (`DATABASE_URL_PERF`). Script MUST refuse to run if the URL does not end with `_perf` (guardrail against polluting Ryan's dev DB or hitting localhost).

**Tests:**
- `tests/unit/compiler.test.ts` — every node type + condition type + custom-field type + parameter escaping.
- `tests/unit/compiler-nesting.test.ts` — 4-level nested and/or.
- `tests/perf/25k.test.ts` — asserts p95.

**Checkpoint:** perf test green. Do NOT proceed until this passes.

### Milestone 2 — Prisma migration + shared utilities + boot-standalone script
**Files:**
- `prisma/schema.prisma` — full frozen schema from §5 (Agent A tables + verbatim B/C/D tables from shared context + `NotifyOverflow`).
- Migration file: `prisma/migrations/<timestamp>_initial/migration.sql`.
- `src/lib/shared/prisma.ts` — singleton PrismaClient with pino logger integration.
- `src/lib/shared/logger.ts` — pino with `correlationId` binding.
- `src/lib/shared/sentry.ts` — init + `withCorrelationId` wrapper.
- `src/lib/shared/auth.ts` — `getCurrentOrgId()` returns the single-seat org.
- `src/lib/shared/correlation.ts` — middleware to read/gen `x-correlation-id`.
- `src/lib/shared/reason-codes.ts` — re-exports `REASON_CODES` from `contracts/http/reason-codes.ts` (planner-published; if the file is missing, fail the migration and message the planner).
- `scripts/boot-standalone.ts` — starts Next dev + mock compliance server on port 5555 + pg-boss worker. Prints `SLICE READY` to stdout when all subsystems responded.

**Tests:**
- `tests/unit/prisma-connectivity.test.ts` — connects and runs a trivial query.
- `tests/unit/correlation.test.ts` — middleware generates and echoes correlation ID.
- `tests/unit/reason-codes.test.ts` — asserts `REASON_CODES` includes at minimum `timezone_unresolved` (fail-closed fallback A depends on).

**Checkpoint:** `pnpm run boot-standalone` prints `SLICE READY` and `curl localhost:3000/api/core-data/health` returns `ok`.

### Milestone 3 — CRUD endpoints (Lead, Contact, Opportunity, Task, Activity read)
**Files:** as before. Lists paginated by `updatedAt desc`, default 50. Detail includes populated custom fields (null-valued hidden). Activities append-only from event consumers (POST returns 405). Zod-validate every body.

**Tests:**
- `tests/unit/leads-crud.test.ts`, `tests/unit/contacts-crud.test.ts`, etc.
- `tests/unit/lead-detail-custom-fields.test.ts` — null-valued custom fields are HIDDEN.

**Checkpoint:** all CRUD suites green.

### Milestone 4 — Smart View CRUD + POST /api/data/search + GET /api/queue
**Files:**
- `src/app/api/smart-views/[...]` — CRUD.
- `src/app/api/data/search/route.ts` — s_query executor.
- `src/app/api/queue/route.ts` — orchestrates primacy resolution, unconditional compliance call, sort, top N. Emits `primaryPhoneE164` in response (renamed from `primaryPhone`).
- `src/lib/core-data/smart-view/queue-service.ts` — orchestration (§7 mandatory behavior).
- `src/lib/core-data/query-dsl/compliance-bridge.ts` — batched (default 100, cap 100) call to `/api/compliance/callable-now`, fail-closed on any error, matches results back by `contactPhoneId`, validates `reasons` values against `REASON_CODES`.
- `contracts/mocks/compliance/server.ts` — Fastify mock. Returns configurable canned responses. Rejects batches >100 with 413 to keep the executor honest. Emits responses with the LOCKED shape `{ results: [{ contactPhoneId, phone, callable, reasons, reasonDetails? }] }` with `reasons` drawn only from `REASON_CODES`.

**Tests:**
- `tests/unit/queue-service-primacy.test.ts` — primary Contact/phone/timezone resolution matches §7 rules; response uses `primaryPhoneE164`.
- `tests/unit/queue-service-no-phone.test.ts` — leads without primary phone excluded, counted in `excludedNoPhone`.
- `tests/unit/queue-service-compliance-fail.test.ts` — 5xx from compliance → those phones excluded, counted in `excludedCompliance`, `stale=true`, reason set.
- `tests/unit/queue-service-empty-view.test.ts` — empty view returns empty leads + zero counts.
- `tests/unit/queue-service-unconditional-scrub.test.ts` — SavedView with NO `callable_now` predicate still triggers `/api/compliance/callable-now`.
- `tests/unit/queue-service-timezone-split.test.ts` — Lead+Contact both tz=null: (a) compliance request entry has NO fabricated tz; (b) response `timezone` field is `'America/New_York'`; (c) if C returns `callable:false` with `reasons:['timezone_unresolved']`, the lead is counted in `excludedCompliance`, `stale` stays FALSE.
- `tests/unit/queue-service-unknown-reason-code.test.ts` — compliance returns a reason string not in `REASON_CODES`; phone excluded, Sentry warning logged, `stale` NOT set.
- `tests/unit/queue-service-response-shape.test.ts` — asserts `primaryPhoneE164` (not `primaryPhone`), `excludedNoPhone`, `excludedCompliance`, `displayName`, `timezone`, `primaryAddressSummary`, `stale`, and optional `staleReason` all present with correct types.
- `tests/integration-local/queue-e2e.test.ts` — full path with mock compliance running.

**Checkpoint:** GET /api/queue against the 25k perf seed returns in <500ms p95.

### Milestone 5 — DealFlow signal sync cron
**Files:**
- `src/lib/core-data/dealflow-sync/ro-client.ts` — pg client using `DATABASE_URL_DEALFLOW_RO`.
- `src/lib/core-data/dealflow-sync/sync.ts` — join + upsert.
- `src/lib/core-data/dealflow-sync/promote.ts` — updates ammunition columns on Lead.
- `src/app/api/cron/dealflow-signal-sync/route.ts` — bearer-auth wrapper.
- Emits `lead.derived-signals-synced` NOTIFY on success (no `eventName` field).

**Fixture DB (concrete):**
- `contracts/mocks/dealflow-ro/docker-compose.yml` — spins a local Postgres 16 container on port 55432. Committed to repo.
- `contracts/mocks/dealflow-ro/fixture.sql` — seeds a minimal DealFlow schema (`MojoContact`, `Match`, `CallQueueEntry`, `ExtractedOpportunity`) with 200 rows of golden fixture data. Committed to repo.
- Executor runs `docker compose -f contracts/mocks/dealflow-ro/docker-compose.yml up -d` before the integration-local test.
- Integration-local test sets `DATABASE_URL_DEALFLOW_RO=postgres://…@localhost:55432/dealflow_fixture` and runs the sync. Assertions on golden expected `DealFlowDerivedSignal` shape.
- CI runs the same docker compose in its GitHub Actions services block.

**DealFlow schema you're reading (reference — DealFlow's tables, NOT yours):**
- `MojoContact(id, mojoId, phone, name, ...)`
- `Match(id, counterpartId, matchFit, captureStatus, matchFitConfidence, ...)`
- `CallQueueEntry(id, mojoContactId, queueRank, priorityScore, queueReason, generatedAt, ...)`
- `ExtractedOpportunity(id, ...)`

**Sync algorithm:**
1. `SELECT * FROM "CallQueueEntry" WHERE "generatedAt" = (SELECT MAX("generatedAt") FROM "CallQueueEntry") LIMIT 500`.
2. JOIN `MojoContact` for `mojoId`, JOIN top `Match` for capture details.
3. For each result: `INSERT ... ON CONFLICT (mojoId) DO UPDATE ...` on `DealFlowDerivedSignal`.
4. `UPDATE "Lead" SET priorityScore = ..., ... WHERE "mojoId" IN (...)`.

**Tests:**
- `tests/unit/dealflow-sync-join.test.ts` — golden fixture → expected `DealFlowDerivedSignal` shape (pure function; no DB).
- `tests/unit/dealflow-sync-failure.test.ts` — RO DB unreachable → no data cleared, error surfaced, existing signals preserved.
- `tests/integration-local/cron-endpoint.test.ts` — bearer auth + sync round-trip against the docker fixture DB.
- `tests/unit/dealflow-sync-emit-shape.test.ts` — assert emitted `lead.derived-signals-synced` payload has NO `eventName` field.

**Stub path:** `DEALFLOW_SYNC_STUB=1` returns fixture data directly without any DB call (unit-scope shortcut). Unset in production and when the docker fixture is running.

**Checkpoint:** cron succeeds against docker fixture; failure mode preserves data.

### Milestone 6 — AI Importer

**Kickoff step (MANDATORY):** invoke the `claude-api` skill via ToolSearch/Skill to lock the exact current Sonnet 4.6 model ID. Do NOT hardcode `claude-sonnet-4-6` from memory. Update `.env.example` and `ai-mapping.ts` constants with the confirmed ID before writing any code that calls Anthropic.

**Files:**
- `src/lib/core-data/importer/upload.ts` — R2 streaming upload; `@aws-sdk/client-s3` with R2 endpoint.
- `src/lib/core-data/importer/parser.ts` — `papaparse` (CSV, streaming) + `xlsx` (Excel); header + 20 sample rows.
- `src/lib/core-data/importer/ai-mapping.ts` — Anthropic call. `@anthropic-ai/sdk`. Model from env (see kickoff).
- `src/lib/core-data/importer/dedup.ts` — E.164 normalize via `libphonenumber-js` (`parsePhoneNumber(raw, 'US')`). Dedup on `(organizationId, phone)`. Fallback to `Lead.name + primaryAddressFull`. Also normalizes `ContactPhone.type` (see below).
- `src/lib/core-data/importer/commit-worker.ts` — pg-boss `import.commit` worker. Streams CSV row-by-row; batches upserts in groups of 500. **Sets `Lead.source = "import:" + importBatchId` on every upsert (locked A-side commitment for C's bulk-scrub).**
- API routes: `src/app/api/imports/route.ts`, `.../[id]/route.ts`, `.../proposed-mapping/route.ts`, `.../commit/route.ts`.
- UI: `src/app/imports/page.tsx`, `src/app/imports/[id]/mapping-review/page.tsx`, `src/app/imports/[id]/progress/page.tsx`.

**Phone-type normalization (dedup.ts):**
Free-form incoming values are lowercased and mapped to the canonical set `{office, mobile, home, direct}`:
- `cell`, `cellular`, `mob`, `mobile phone` → `mobile`
- `work`, `office phone`, `business` → `office`
- `home phone`, `residential` → `home`
- `direct dial`, `dd` → `direct`
- Anything else → kept as-is, lowercased, and flagged as `nonstandard` in the import errorLog for Ryan's review.

**Anthropic prompt (system):**
```
You are a CSV column mapper for a real-estate CRM. You will map spreadsheet columns to CRM fields.

STANDARD FIELDS (map to these when they fit):
- Lead.name (string)
- Lead.primaryAddressFull (string, full address in one line)
- Lead.mojoId (string, Mojo Dialer internal contact ID) — HIGH-VALUE, DETECT AGGRESSIVELY.
  Ryan's Mojo export column may be labeled "Contact ID", "Mojo ID", "MojoID", "ID",
  "Dialer ID", or similar. Prefer standard_field mapping to Lead.mojoId if the values
  look like short numeric or alphanumeric identifiers AND the header hints at "id".
  Missing this mapping breaks downstream signal sync — err on the side of mapping.
- Lead.statusLabel (string)
- Contact.name (string, human person name)
- Contact.title (string)
- ContactPhone.phone (E.164 phone number)
- ContactPhone.type (office|mobile|home|direct — post-normalized downstream; you may return synonyms)
- ContactEmail.email (email address)

If a column does not fit any standard field, propose a NEW custom field:
- name: human-readable label
- type: text | number | date | datetime | url | email | choices
- choices: only if type=choices AND column has <20 distinct values

If a column is ambiguous or garbage, return kind:"ignore".

RULES:
- NEVER hallucinate. If uncertain, use ignore with reasoning.
- Flag likely duplicate columns (e.g., "Phone" and "Phone Number").
- Confidence is 0-1. Below 0.5 = uncertain.

Output JSON only, matching the schema.
```
User: header + 20 sample rows + JSON schema.

**Idempotency:**
- Same CSV → same result.
- Dedup on `ContactPhone.phone` unique in-org.
- `CustomFieldDefinition` unique on `(organizationId, objectType, name)`.
- `CustomFieldValue` unique on `(definitionId, objectId)` with `createMany({ skipDuplicates: true })`.
- `mojoId` unique on Lead — updates existing rather than inserts duplicates.
- `Lead.source` overwritten on every upsert to `"import:" + importBatchId` — most recent import wins the source stamp (documented so C's bulk-scrub semantics are predictable).

**Emitted event shape (again, for clarity):**
```ts
// channel: crm_lead_sync
{ leadId, sourceLabel, importBatchId, correlationId }   // NO eventName field
```

**Tests:**
- `tests/unit/parser.test.ts` — CSV with quoted commas, XLSX with mixed types.
- `tests/unit/ai-mapping.test.ts` — mock Anthropic; verify prompt shape + response parsing; verify mojoId aggressive detection with header variants ("Contact ID", "MojoID", "Dialer ID").
- `tests/unit/dedup.test.ts` — phone normalization + fallback + type normalization synonyms.
- `tests/unit/commit-worker-source-convention.test.ts` — asserts every upserted Lead has `source = "import:" + importBatchId`.
- `tests/unit/commit-worker-emit-shape.test.ts` — asserts `lead.upserted-from-import` payload has NO `eventName` field.
- `tests/integration-local/importer-idempotency.test.ts` — commit same CSV twice → row count unchanged.
- `tests/integration-local/importer-1k.test.ts` — 1000-row synthetic CSV → success in <60s, correct counters.

**Checkpoint:** upload → propose → commit → idempotent re-commit all pass. Every upserted Lead has `source LIKE 'import:%'`.

### Milestone 7 — Event listeners
**Files:**
- `src/lib/core-data/events/listen.ts` — one persistent pg connection per channel, dispatches to handlers via `demux.ts`.
- `src/lib/core-data/events/demux.ts` — shape-based predicate dispatcher (no `eventName` discriminant). Ignores unknown shapes with a debug log; NEVER crashes.
- `src/lib/core-data/events/emit.ts` — `NOTIFY` helper wrapped in current transaction; strips any accidental `eventName` field before serializing; handles `NotifyOverflow` for >7500-byte payloads.
- `src/lib/core-data/events/handlers/*` — one file per event. `scrub-completed.ts` is a no-op observability logger per §6.

**Rules:**
- Each handler runs in a pg-boss job for idempotent retry.
- Idempotency keys per §6 (channel-prefixed; verified distinct for call.connected vs call.completed without relying on `eventName`).
- Handler failures Sentry-log + retry with backoff (pg-boss default).
- `call.completed` handler accepts `cost` as `string | null` and DOES NOT coerce to number.

**Tests:**
- `tests/unit/events/demux.test.ts` — unknown payload shape on `crm_call` returns gracefully (log-and-continue); `dial-session.pacing-update` shape is routed to the no-op.
- `tests/unit/events/emit-no-event-name.test.ts` — even if a caller passes an extra `eventName` field to `emit()`, the serialized NOTIFY payload does NOT contain it.
- `tests/unit/events/call-completed-cost.test.ts` — cost is stored as string; JSON `"12.3400"` does not become numeric `12.34`.
- `tests/unit/events/*` — one per handler, simulate payload → assert Activity row shape.
- `tests/unit/events/scrub-completed.test.ts` — verifies handler ONLY logs, writes nothing.
- `tests/integration-local/dup-emit.test.ts` — emit `call.connected` and `call.completed` for the same callId → distinct handlers fire; emit same event 3x → single Activity row.

**Checkpoint:** all four consumer handlers idempotent; dispatcher robust to unknown shapes.

### Milestone 8 — Contract tests (both directions)
**Files:**
- `contracts/events/` — zod schemas for every event payload (from §6). NONE include an `eventName` field. Payload identity is by channel + shape.
- `contracts/http/` — OpenAPI-style JSON docs for every HTTP contract (from §7), including:
  - `contracts/http/compliance-callable-now.json` — request has `contactPhoneIds` with `maxItems: 100`; response has `results[].contactPhoneId`, `phone`, `callable`, `reasons` (array of `REASON_CODES` string), optional `reasonDetails`.
  - `contracts/http/reason-codes.ts` — the frozen enum (planner-published; A imports).
  - `contracts/http/queue-response.json` — response uses `primaryPhoneE164`, includes `excludedNoPhone`, `excludedCompliance`, `stale`, `staleReason?`, `displayName`, `timezone`, `primaryAddressSummary`.
- `contracts/tests/emits-events.test.ts` — trigger emitters, capture NOTIFY payload, assert against zod schema AND assert `eventName` field is absent.
- `contracts/tests/accepts-events.test.ts` — send payloads matching schemas to listeners, assert side effects; include a `dial-session.pacing-update` variant to prove no-crash + no-write.
- `contracts/tests/http-shapes.test.ts` — every exposed endpoint's response validated against zod-imported-from-openapi. Includes queue-response tests for `primaryPhoneE164`, `excludedNoPhone`, `excludedCompliance`, and non-null guarantees on `contactId`/`primaryPhoneId`/`primaryPhoneE164`.
- `contracts/tests/mock-fidelity.test.ts` — mock compliance server's responses AND its 413-on-oversized-batch behavior AND its adherence to `REASON_CODES` validated against C's frozen schema.

**Checkpoint:** contract suite green in both directions.

### Milestone 9 — UI (minimal, functional)
Front-load in this order:
1. `/leads` list — server-side render via `POST /api/data/search`; column selection + sort.
2. `/leads/[id]` detail — standard fields + populated custom fields section + activity timeline paginated.
3. `/queue` preview — read-only preview of `/api/queue?viewId=...&limit=50`, showing `excludedNoPhone` / `excludedCompliance` counts + `stale` banner. Renders `primaryPhoneE164` label.
4. `/imports` upload + mapping review + progress.

Use shadcn/ui. React Server Components where possible. Keyboard shortcuts via the planner-scaffolded hook.

**Acceptance test (replaces "RTL snapshots + basic interaction"):**
- `tests/e2e/importer-happy-path.spec.ts` (Playwright): a fresh worker uploads a 500-row synthetic CSV, reviews the AI mapping (all rows visible, dropdowns populated, ≥1 auto-suggested `new_custom_field`), clicks commit, waits for progress = 100%, navigates to `/leads`, and sees ≥1 imported lead with the expected `displayName` AND `source` starting with `"import:"`. Runs against the boot-standalone stack (mocks up). Fails the milestone if any step requires DevTools intervention.
- Additional RTL snapshots + interaction tests are still allowed but are NOT the acceptance signal.

UI test coverage is NOT counted toward the 85% floor (which applies to critical paths).

### Milestone 10 — Backup + restore + observability polish + handoff doc
- `scripts/backup.ts` — pg_dump to R2 weekly (pg-boss cron).
- `scripts/restore-from-backup.ts` — documented + tested once (Ryan runs). REQUIRED for Gate 1 sign-off.
- Sentry: exceptions in every route wrapped via route decorator; correlation IDs attached.
- Pino logs: JSON, correlation-id on every line.
- Health endpoint: check DB, DealFlow RO, Anthropic (HEAD), R2 (HEAD).
- `docs/agent-a-handoff.md` — one-page summary per §14.
- `docs/perf-25k-report.md` — perf numbers per §14.
- `docs/ops.md` — backup + restore commands + one-time restore-test result.
- `docs/observability.md` — Sentry screenshot + pino sample line.

**Checkpoint:** backup ran once; restore ran once; both documented; handoff doc written.

---

## 10. The Three Acceptance Gates

CI runs all three. Each is its own CI job. NO slice enters integration RED.

### Gate 1 — Runs in isolation
The slice boots on its own, connects only to its own tables, responds to requests, with EVERY dependency mocked and NO other agent's code present.

**Exact command:**
```bash
cd worktrees/agent-a
pnpm run boot-standalone
```
This must:
1. Start docker fixture DB for DealFlow RO on port 55432 (via docker compose).
2. Start Next.js dev server on port 3000.
3. Start Fastify mock compliance server on port 5555.
4. Start pg-boss worker for `import.commit` and event handlers.
5. Print `SLICE READY` when all subsystems responded.
6. `curl localhost:3000/api/core-data/health` returns `{ status: "ok", ... }`.

Agents B, C, D real services are NOT running. The slice completes an end-to-end scenario (upload CSV → propose mapping → commit → row appears in `/api/queue`) against mocks only.

### Gate 2 — Honors the contract (BOTH DIRECTIONS)
Slice passes `contracts/tests/` in both directions:

- **A → real services it OWNS:** contract tests trigger every emitted event and every exposed HTTP endpoint against the RUNNING real slice, asserting payload/response shapes match the frozen schemas field-for-field. Includes assertions that emitted event payloads do NOT contain `eventName`, that queue response uses `primaryPhoneE164`, and that `Lead.source` for importer-created leads starts with `"import:"`.
- **A → mocks it CONSUMES:** contract tests validate every mock's responses against C's frozen schemas — proves the mocks are faithful. The compliance mock's max-100-per-batch cap is validated by the mock's own 413 behavior on oversized batches AND by `contracts/http/compliance-callable-now.json` constraints. The mock's response includes `contactPhoneId` AND `phone` AND uses only `REASON_CODES` values.

**Command:**
```bash
pnpm run test:contract
```
Both directions green.

### Gate 3 — Does its job
Behavioral acceptance tests specific to Agent A's purpose, PLUS a coverage floor of **85%** on critical paths.

**Critical paths (must have ≥85% line coverage):**
1. `src/lib/core-data/query-dsl/compiler.ts` + `executor.ts`
2. `src/lib/core-data/smart-view/queue-service.ts` (primacy + compliance + sort + split-timezone semantics)
3. `src/lib/core-data/importer/commit-worker.ts` + `dedup.ts`
4. `src/lib/core-data/dealflow-sync/sync.ts` + `promote.ts`
5. `src/lib/core-data/events/demux.ts` + `emit.ts` (no-`eventName` invariant, cost-as-string invariant)

Plus the 25k perf assertion in `tests/perf/25k.test.ts` must pass.

**Coverage configuration (real Vitest syntax):**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/app/**', 'src/**/*.test.ts', 'src/types/**'],
      thresholds: {
        // Global floor (loose)
        lines: 70,
        // Per-file 85% floor on critical paths
        'src/lib/core-data/query-dsl/compiler.ts':       { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/query-dsl/executor.ts':       { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/smart-view/queue-service.ts': { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/importer/commit-worker.ts':   { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/importer/dedup.ts':           { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/dealflow-sync/sync.ts':       { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/dealflow-sync/promote.ts':    { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/events/demux.ts':             { lines: 85, functions: 85, branches: 80 },
        'src/lib/core-data/events/emit.ts':              { lines: 85, functions: 85, branches: 80 },
      },
    },
  },
})
```

`package.json` scripts:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:contract": "vitest run tests/contract",
    "test:coverage": "vitest run --coverage",
    "test:perf": "vitest run tests/perf",
    "boot-standalone": "tsx scripts/boot-standalone.ts"
  }
}
```

**Command to run Gate 3:**
```bash
pnpm run test:coverage && pnpm run test:perf
```

Vitest will fail the run with a non-zero exit if any per-file threshold is unmet.

**All three gates green = slice is ready for integration.**

---

## 11. Failure-Mode Behavior

Every external dependency has a defined failure mode. Fail-closed on compliance; otherwise queue-and-retry or serve-stale-with-flag.

| Dependency | Failure | Behavior |
|---|---|---|
| `DATABASE_URL_MAIN` | Down | Health returns `down`; 5xx on writes. Sentry alert. |
| `DATABASE_URL_DEALFLOW_RO` | Unreachable | Cron logs to Sentry; returns 503. Existing `DealFlowDerivedSignal` rows preserved. `/api/queue` sets `stale=true` with reason `"DealFlow signals last synced Nh ago"`. |
| Anthropic API | 5xx / timeout | Retry once with 2s backoff. Second failure → 503 with `{ error: "AI mapping unavailable, retry" }`. NEVER guess the mapping. |
| R2 | Unreachable | Upload: 503. Backup: pg-boss retries with exponential backoff. |
| `POST /api/compliance/callable-now` | 5xx / timeout / malformed / missing phone entries | **Fail-closed:** every affected phone treated as `callable:false`; leads excluded, counted in `excludedCompliance`. Set `stale=true`, reason `"Compliance service unavailable"`. Sentry alert. |
| `POST /api/compliance/callable-now` | `reasons` value outside `REASON_CODES` | **Fail-closed for that phone** (exclude, count in `excludedCompliance`); log Sentry warning "compliance returned unknown REASON_CODE"; DO NOT set `stale` (this is a contract-drift signal, not an outage). |
| pg NOTIFY listener | Payload shape not recognized on subscribed channel | Log-and-continue at info-level; NEVER crash the listener. |
| pg NOTIFY listener disconnects | Reconnect on backoff (max 60s); catch-up query on reconnect using timestamp columns. |
| pg-boss worker crashes | Auto-restart via process supervisor; jobs are queued in Postgres. |

Every failure logs `{ correlationId, event, dependency, error }` to Sentry + pino.

---

## 12. Contract Change Protocol

If, during your build, you discover that a frozen contract in this brief is wrong (e.g., an event field that can't be computed, an HTTP shape that doesn't fit the data, a table field of the wrong type, batch-size cap needing change, a `REASON_CODES` value missing):

**STOP. Do not work around locally. Do not silently patch.**

Message Ryan (the planner) with:
1. Which contract is wrong (event name / endpoint / schema field / enum member).
2. Why it can't work as specified.
3. Proposed change (minimum-viable-fix).

Ryan updates `dealflow-crm/CONTRACTS.md` + contract-test schemas + notifies all agents to re-pull. You resume once the change lands in your worktree via `git pull origin main`.

**Silent patches collapse 4-agent parallelism.** This is the single most important rule.

Known planner-owned open items that could touch A (do NOT implement locally; wait for planner update):
- `OAuthCredential` model — D's ask.
- `BulkScrubCheckpoint` model — C's ask.
- `Call.emittedAt` field — B's ask.
- `ScrubLog.operation` enum extension — C's ask.
- `Message.status` enum vs Twilio delivery states — D's ask.

None of these block A's Gate 1/2/3. A ships against the current frozen schema.

---

## 13. Ryan's Preferences (Applies to Every Commit)

- **Always type deliverables in chat** as full copyable text if Ryan asks for a summary.
- **`import 'dotenv/config'` MUST be the first import** of any script that touches DB.
- **Run `pnpm prisma generate` between `migrate dev` and `tsc`.**
- **iCloud landmine:** guard against ` 2.ts` / ` 2.tsx` duplicate files (see §8).
- **Prisma sequential `.create()` against Railway ≈ 90ms/row.** Use `createMany({ skipDuplicates: true })` or pg-boss for >100 rows.
- **Ship-when-tested.** If Gate criteria pass, do not gate on extra approvals.
- **Minimum-viable-fix.** Do not ladder up to multi-phase plans.
- **Prefer stronger model.** Claude Sonnet 4.6 for importer AI mapping. Lock exact model ID via `claude-api` skill at Milestone 6 kickoff.
- **NYC context.** Timezones default to `America/New_York` for NYC-based leads in the DISPLAY layer only. Compliance calls never carry fabricated timezones.
- **UTC everywhere.** All timestamps stored UTC. Convert at display only.
- **No emojis in code or logs** unless Ryan explicitly asks.
- **Verify audits with live tests.** Coverage reports and static audits are frequently wrong — run a live test before architecting on top of them.
- **Never hallucinate real-estate data.** Null in = null out.

---

## 14. Handoff / Integration Prep

When all three gates are green, your slice is ready. Deliverables at handoff:

1. **`agent-a` branch pushed** — all commits, all migrations, all tests green.
2. **`docs/agent-a-handoff.md`** — one-page summary:
   - Boot command (`pnpm run boot-standalone`).
   - Test commands (`test`, `test:contract`, `test:coverage`, `test:perf`).
   - Env vars needed at runtime (from §4).
   - Cross-brief lock-downs applied (no `eventName` in emissions; `primaryPhoneE164` in queue; `cost` string-decimal; `Lead.source = "import:" + importBatchId`; batch cap 100; timezone split semantics; `REASON_CODES` sourced from contracts).
   - Known limitations / open planner items.
3. **Migration file** — one migration, additive-only. If more than one, squash before handoff.
4. **Mock compliance server** — runnable via `pnpm run mock:compliance`; enforces the 100-per-batch cap; responses use locked `{ contactPhoneId, phone, callable, reasons, reasonDetails? }` shape.
5. **DealFlow docker fixture** — `contracts/mocks/dealflow-ro/docker-compose.yml` + `fixture.sql` committed and documented.
6. **DealFlow RO client stub** — behind `DEALFLOW_SYNC_STUB=1` flag for unit-scope shortcuts.
7. **Perf report** — `docs/perf-25k-report.md` with p50/p95/p99 for all 20 test queries.
8. **Backup + restore documented** — `docs/ops.md`.
9. **Sentry + pino sample** — `docs/observability.md`.
10. **Playwright happy-path recording** — `tests/e2e/importer-happy-path.spec.ts` green in CI.

**Integration phase (after all four slices done):**
- Swap mock compliance for real Agent C service (update `COMPLIANCE_BASE_URL`).
- Wire real Agent B `call.connected` / `call.completed` events (verify `cost` arrives as string).
- Wire real Agent D `message.received` events + confirm D consumes `lead.upserted-from-import` for thread reconcile.
- End-to-end smoke: upload real Mojo CSV → confirm every Lead `source = "import:<batchId>"` → run DealFlow sync → open `/api/queue` → confirm rank + ammunition + `primaryPhoneE164` shape → verify C's REASON_CODES enum on any excluded phones.
- Ryan runs the final on-device / on-laptop UX pass.

**Handoff signal:** open a PR from `agent-a` → `main` with title `Agent A — Core Data slice ready for integration`. Paste your handoff summary + gate results in the description.

---

END OF AGENT A BRIEF. Everything you need to build the slice in isolation for the next 1–3 weeks is in this document. If something is missing, STOP and ask the planner — do not invent contracts.