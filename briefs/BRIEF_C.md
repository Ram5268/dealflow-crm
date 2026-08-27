# Agent C Executor Brief — Compliance Gate (DNC, Timezone, Litigator)

## Front matter

You are building the **compliance slice** of `dealflow-crm`, a new single-operator real-estate CRM that replaces a solo NYC broker's Mojo Dialer + Mojo CRM setup. Your slice is the **legal fail-safe layer** that decides, for every phone number the dialer wants to call, whether that call is legally permitted **right now**. Every other slice defers to you before initiating outbound contact. Your first, second, and third rule is: **fail-closed**. Any error, timeout, missing configuration, missing policy confirmation, ambiguous timezone, or unreachable vendor produces `callable: false` — never a positive-safe signal from a negative check. There is no "assume clean" path. Ever.

You are working in isolation for 1-3 weeks. Three other executors are building sibling slices (Core Data / Telephony / Communications) in parallel worktrees against a frozen contract. You will not see their code. You will consume mocks and expose real HTTP + LISTEN/NOTIFY contracts.

---

## 1. Project context

**Who Ryan is.** Ryan Martin, solo NYC Douglas Elliman real-estate broker, non-engineer, one seat, one operator. He calls consumers (buyers, sellers, renters, landlords) all day. He is the only user of this system. NYC is the reference market — the vast majority of contacts are in `America/New_York`, with occasional NJ/CT/PA/FL, and rare cross-country outliers.

**What DealFlow is.** `dealflow-inbox-intelligence` is Ryan's existing sibling app that reads his Outlook inbox, classifies real-estate emails, extracts opportunities, and runs a nightly matcher + ranker that produces a smart call queue. **DealFlow keeps running.** It writes its own tables in its own database. It is not being replaced.

**What `dealflow-crm` is.** A new sibling repository (`dealflow-crm/` next to `dealflow-inbox-intelligence/`) that replaces Mojo Dialer + Mojo CRM. It is:
- Property-centric Lead/Contact database (Close CRM's data model is the schema source-of-truth).
- WebRTC softphone (Twilio Voice JS SDK) with ammunition-panel on connect.
- Multi-line power/predictive dialer with adaptive pacing under TCPA's 3%-over-30-days abandonment cap.
- Consumer-calling compliance layer — **which is you** — that Close and Mojo don't provide.
- Two-way email + SMS sync.
- AI-driven CSV importer (Mojo-style): Ryan drops a CSV, AI auto-maps columns, custom fields for the rest.

**Stack, frozen, exact pins:** Next.js 16.2.5, React 19.2.4, TypeScript 5.6+, Prisma 7.8+, PostgreSQL 16 (Railway), Tailwind 4, shadcn/ui, react-hook-form + zod, Vitest, pnpm 9, Node 22 LTS, pino, Sentry, Doppler for secrets, pg-boss for background queues. **No Redis, no GraphQL, no Supabase.**

**Real-time transports:** Postgres `LISTEN/NOTIFY` for server↔server event fan-out (emit in the same tx as state change), and a separate SSE bridge for browsers. You emit on `crm_scrub`. You consume nothing.

**Deploy topology:** Next.js on Vercel; Postgres on Railway; SSE bridge and background workers (yours: nightly DNC refresh, holiday refresh, bulk-scrub worker) on Railway.

**Database strategy.** SAME Railway PG server as DealFlow, DIFFERENT logical DB (`dealflow_crm`). Your slice's **write ownership** is the seven tables in §7. **You additionally hold READ-ONLY access to Agent A's Contact / ContactPhone / Lead / ImportBatch tables via Prisma SELECT on the same `dealflow_crm` DB** (this is explicitly consistent with SHARED_CONTEXT §4: "Agents CAN read any table; SELECTs across ownership are fine"). You do NOT call Agent A over HTTP for these reads at runtime — you SELECT directly. Your read pattern is documented in §7A below.

**Repository layout (already scaffolded by planner):**

```
dealflow-crm/
├── CONTRACTS.md
├── contracts/
│   ├── reference/close-openapi.json
│   ├── events/              ← Zod schemas per event
│   ├── http/                ← OpenAPI-style docs for cross-slice endpoints
│   ├── mocks/<slice>/       ← fixtures + runnable mock service
│   └── tests/               ← contract test suite (Vitest + Zod, both-directions)
├── prisma/schema.prisma
├── src/
│   ├── app/                 ← Next.js App Router
│   ├── lib/
│   │   ├── shell/           ← app shell (planner-scaffolded)
│   │   ├── dealflow-sync/
│   │   ├── core-data/       ← Agent A
│   │   ├── telephony/       ← Agent B
│   │   ├── compliance/      ← Agent C  ← YOU
│   │   └── comms/           ← Agent D
│   └── types/
├── scripts/
├── worktrees/               ← .gitignored
└── .env.example
```

Your slice lives entirely under `src/lib/compliance/` plus its Next.js route handlers under `src/app/api/compliance/**` and `src/app/api/cron/{dnc-refresh,holiday-refresh}/`.

---

## 2. What this slice owns

### Tables (WRITES)

You are the sole writer to these seven tables. No other agent writes to them; agents may SELECT freely.

- `DncSuppression` — federal, state, and internal DNC entries.
- `LitigatorSuppression` — known TCPA litigators from vendor.
- `MobileLineCache` — Twilio Lookup line-type cache (90-day TTL).
- `CallingWindowConfig` — per-timezone calling policy, gated by `policyConfirmedBy`.
- `HolidaySuppressionDate` — federal + per-state holidays that block outbound calls.
- `ScrubLog` — append-only forensic evidence of every decision, forever.
- `BulkScrubCheckpoint` — resumable bulk-scrub checkpoint per ImportBatch (see §5 and §12 note on planner-approved addition).

### Tables (READ-ONLY across ownership)

You SELECT (never INSERT/UPDATE/DELETE) from Agent A's tables via the same Prisma client and same `dealflow_crm` DB:

- `Contact` — read `timezone`, `leadId` (join key to Lead for address).
- `ContactPhone` — read `id`, `phone`, `contactId`, `lineType` (Agent A promotes from your `MobileLineCache`).
- `Lead` — read `addresses` (JSON) for `stateFromTimezone` resolution and `id` for ImportBatch join.
- `ImportBatch` — read `id`, `organizationId`, `status`, `sourceLabel` to enumerate a bulk-scrub target.
- `Organization` — FK target for your writes.

**How you find "all ContactPhones in an ImportBatch":** the `ImportBatch.id` is stored on `Lead.source` as the exact string `"import:" + importBatchId` (per §12 pre-authorized change #5 below). This is a **planner-locked Agent A commitment** — NOT the older `"mojo-import-<date>"` example from SHARED_CONTEXT §3, which is superseded for programmatic joins. At the start of your session, verify CONTRACTS.md ratifies this convention. If not, **STOP and message the planner** — do not guess the join key. This is a §14 contract question, not something to work around.

### HTTP endpoints (you expose)

- `POST /api/compliance/scrub` — bulk scrub a list of phones.
- `POST /api/compliance/callable-now` — real-time callable check by contactPhoneId; called inline by Agent B before every dial. **Batch cap: 100 contactPhoneIds per request** (see §7.2 and §7A).
- `GET  /api/compliance/dnc/suppressions?phone=E164` — read suppressions for a phone.
- `POST /api/compliance/dnc/internal` — add a phone to internal DNC (survives re-imports). Consumed by Agent D on SMS STOP.
- `POST /api/compliance/policy/confirm` — Ryan confirms a `CallingWindowConfig`.
- `GET  /api/compliance/policy/status` — configured policies + which are unconfirmed.
- `GET  /api/compliance/health` — health check.
- `POST /api/compliance/circuit/resume` — bearer `CRON_SECRET`; un-halts an open vendor circuit-breaker. (Full contract in §7.10; also referenced in §11 failure table.)
- `GET  /api/cron/dnc-refresh` — bearer `CRON_SECRET`, nightly.
- `GET  /api/cron/holiday-refresh` — bearer `CRON_SECRET`, nightly.

### Events emitted (LISTEN/NOTIFY channel `crm_scrub`)

- `scrub.completed` — payload `{ phoneCount: number, blockedCount: number, checkedAt: string /* ISO */, correlationId: string }`.

Emit in the same DB transaction as the ScrubLog writes / suppression writes. **No `eventName` or `type` discriminant field** — the channel `crm_scrub` IS the routing signal. This aligns with the cross-brief convention: all event payloads are discriminant-free; consumers route by channel.

### Events consumed

**None.** You are a pure producer + on-demand query surface. Do not subscribe to any channel. In particular, do NOT emit `sms.stop-received` — Agent D routes SMS STOP through your `POST /api/compliance/dnc/internal` HTTP endpoint (confirmed with planner; the fallback event path in D's brief is NOT to be implemented).

---

## 3. What this slice does NOT touch

Explicit guardrails. Violating any of these breaks parallelism.

**Tables (never write, may only SELECT):**
- Contact, ContactPhone, Lead, ImportBatch (read-only, per §2 above).
- ContactEmail, ContactUrl, Opportunity, Task, Activity, CustomFieldDefinition, CustomFieldValue, SavedView, CustomActivityType, Attachment, DealFlowDerivedSignal (Agent A — no read need, don't touch).
- DialSession, Call, CallLeg, PacingMetric (Agent B).
- Message, EmailThread, MessageTemplate, Sequence, SequenceStep, SequenceEnrollment (Agent D).
- Organization, User (planner-owned).

**Specifically:** you never write `ContactPhone.lineType`. That column is Agent A's. You write `MobileLineCache`; Agent A's Lead detail joins in.

**HTTP endpoints (never call):**
- Anything under `/api/telephony/**`, `/api/comms/**`, `/api/imports/**`, `/api/queue`. If you think you need something from another slice, STOP and message the planner. Runtime cross-slice reads are Prisma SELECT only, never HTTP.

**Never do:**
- Never place calls, send SMS/email, or touch Twilio Voice / Messaging APIs. The only Twilio API you touch is **Twilio Lookup** for line-type identification.
- Never send Outlook / Gmail requests.
- Never modify Microsoft 365 tenant settings.
- Never emit events on any channel other than `crm_scrub`.

---

## 4. Environment / secrets

All secrets injected via Doppler at runtime. Repo has `.env.example` only — commit that, never real values.

**Every slice needs:**
- `DATABASE_URL_MAIN` — Postgres connection to `dealflow_crm` DB.
- `CRON_SECRET` — bearer token for cron endpoints AND the circuit-resume endpoint.
- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`.

**Agent C specifically:**
- `DNC_VENDOR` — **TBD, Ryan will select** from candidates (PossibleNOW, Contact Center Compliance, DNC.com, TCPA Shield). Value is a short identifier, e.g. `possiblenow`, matched by the vendor factory in `src/lib/compliance/dnc/vendors/index.ts`.
- `DNC_API_KEY` — **TBD**, tied to the selected vendor.
- `LITIGATOR_VENDOR` — **TBD** (Blacklist Alliance, TCPA Shield, LitigatorScrub).
- `LITIGATOR_API_KEY` — **TBD**.
- `MOBILE_LINE_VENDOR=twilio_lookup` — fixed.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — shared with Agent B, but you use them only for Twilio Lookup (no Voice/Messaging).
- `NYC_TIMEZONE_DEFAULT=America/New_York` — the fallback IANA zone label used only in tests/fixtures; **runtime NEVER falls back to a default timezone for a real contact**. Missing timezone → callable:false. (Note: Agents A and D may pass a display-layer fallback of `America/New_York` for null-tz contacts to `/api/queue` results and sequence ticks; when those flow into `/api/compliance/callable-now`, you STILL fail-closed on the underlying `Contact.timezone IS NULL`. The compliance check ALWAYS reads the DB row, not a caller-supplied timezone.)

**BLOCKING NOTE:** `DNC_VENDOR` and `LITIGATOR_VENDOR` are unchosen at the time this brief is written. **Milestone 1 does not need them.** Milestone 2 does. If you hit "vendor unchosen" during Milestone 2, STOP and message Ryan. Do NOT pick a vendor yourself. Do NOT stub a vendor and claim Gate 1 passes.

---

## 5. Complete Prisma schema tables this slice owns

Copy VERBATIM into `prisma/schema.prisma`. Do not paraphrase, rename, or reorder fields. Other agents' tables live in the same file — coordinate additive-only migrations via the planner.

**Contract-change note for this brief:** two additions relative to SHARED_CONTEXT §3 must be planner-ratified BEFORE Milestone 0 begins.
1. `ScrubLog.operation` enum vocabulary is extended to include `check-holiday` and `check-mobile-line`. Schema type is `String` so no column change is required, but the **frozen enum vocabulary** is what changes — and the SHARED_CONTEXT enum is a contract. Executor: at start of session, verify Ryan has updated CONTRACTS.md §Event/enum list. If not, STOP and message planner. Do not self-authorize.
2. `BulkScrubCheckpoint` is a NEW table owned by Agent C, added to solve the resumable-bulk-scrub problem without writing to Agent A's `ImportBatch`. Executor: at start of session, verify Ryan has ratified this table in CONTRACTS.md. If not, STOP and message planner.

```prisma
model DncSuppression {
  id String @id @default(cuid())
  organizationId String
  phone String             // E.164
  source String            // federal|state:<XX>|internal
  addedAt DateTime @default(now())
  addedBy String?          // User.id | "sync" | "user-request"
  reason String?
  @@unique([organizationId, phone, source])
  @@index([organizationId, phone])
}

model LitigatorSuppression {
  id String @id @default(cuid())
  organizationId String
  phone String
  vendor String
  vendorMatchId String?
  addedAt DateTime @default(now())
  @@unique([organizationId, phone, vendor])
  @@index([organizationId, phone])
}

model MobileLineCache {
  id String @id @default(cuid())
  organizationId String
  phone String
  lineType String          // mobile|landline|voip|unknown
  carrier String?
  checkedAt DateTime @default(now())
  expiresAt DateTime       // 90-day TTL
  @@unique([organizationId, phone])
  @@index([expiresAt])
}

model CallingWindowConfig {
  id String @id @default(cuid())
  organizationId String
  timezone String          // IANA
  earliestHour Int @default(9)              // MOST RESTRICTIVE default
  latestHour Int @default(20)               // 8pm
  allowedDaysOfWeek Int[] @default([1,2,3,4,5])  // weekdays only default
  policyConfirmedBy String?
  policyConfirmedAt DateTime?
  updatedAt DateTime @updatedAt
  @@unique([organizationId, timezone])
}

model HolidaySuppressionDate {
  id String @id @default(cuid())
  organizationId String
  date DateTime @db.Date
  scope String             // federal | state:XX
  name String
  createdAt DateTime @default(now())
  @@unique([organizationId, date, scope])
  @@index([organizationId, date])
}

model ScrubLog {
  id String @id @default(cuid())
  organizationId String
  phone String
  contactPhoneId String?
  operation String         // check-federal|check-state|check-litigator|check-window|check-internal|check-holiday|check-mobile-line
  result String            // clean|blocked|error
  detail Json?
  checkedAt DateTime @default(now())
  organization Organization @relation(fields: [organizationId], references: [id])
  @@index([organizationId, checkedAt(sort: Desc)])
  @@index([phone])
}

model BulkScrubCheckpoint {
  id String @id @default(cuid())
  organizationId String
  importBatchId String
  lastProcessedContactPhoneId String?
  chunkIndex Int @default(0)
  processedCount Int @default(0)
  totalCount Int @default(0)
  status String @default("running") // running|halted|completed|failed
  haltReason String?
  updatedAt DateTime @updatedAt
  @@unique([organizationId, importBatchId])
  @@index([organizationId, status])
}
```

`dayOfWeek` follows JS convention: 0=Sunday, 1=Monday, ..., 6=Saturday. The default `[1,2,3,4,5]` = Mon-Fri.

After every schema change: **`npx prisma migrate dev` then IMMEDIATELY `npx prisma generate` before running `tsc`.** Stale Prisma types silently mask real errors — Ryan has been bitten by this repeatedly.

Migrations must be additive-only during parallel builds. If you need a breaking change, route through the planner.

---

## 6. Event catalog for this slice

### Emitted

| Event name | Channel | Payload shape (Zod schema in `contracts/events/scrub.completed.ts`) |
|---|---|---|
| `scrub.completed` | `crm_scrub` | `{ phoneCount: number, blockedCount: number, checkedAt: string /* ISO 8601 UTC */, correlationId: string /* uuid v4 */ }` |

Emit inside the same Postgres transaction as the ScrubLog inserts / suppression writes. Use `NOTIFY crm_scrub, '<json>'`. The payload MUST validate against the Zod schema you commit to `contracts/events/scrub.completed.ts`. Field names are camelCase — never snake_case (SHARED_CONTEXT calls out this exact class of mismatch as a Gate 2 failure mode). No `eventName` / `type` discriminant field — channel is the routing signal.

### Consumed

None. Do not open a `LISTEN` on any channel from within Agent C code.

---

## 7. HTTP contracts for this slice

Every endpoint requires header `x-correlation-id` (auto-generate a uuid v4 if missing and propagate through logs + emitted events). All requests are org-scoped via `getCurrentOrgId()` (planner-scaffolded, singleton-org for MVP).

### 7A. The frozen `reasons[]` vocabulary — canonical

Publish this ONCE, in `contracts/http/compliance-reasons.ts`, and re-export it from `src/lib/compliance/index.ts`. Every endpoint and every test iterates over THIS list. **This is the single source of truth referenced by Agents A and B in their consumed-mock schemas.** No other list of reasons appears anywhere else in the codebase. If executor thinks a new reason is needed, STOP → message planner.

```ts
// contracts/http/compliance-reasons.ts
export const REASON_CODES = [
  "internal_dnc",
  "federal_dnc",
  "state_dnc",                    // detail carries the state code, e.g. { state: "NY" }
  "litigator",                    // detail carries the vendor, e.g. { vendor: "blacklist_alliance" }
  "outside_calling_window_hour",  // local hour outside earliestHour..latestHour
  "outside_calling_window_day",   // local dayOfWeek not in allowedDaysOfWeek
  "holiday_federal",              // detail: { name }
  "holiday_state",                // detail: { state, name }
  "holiday_table_stale",
  "policy_unconfirmed",
  "timezone_unresolved",
  "timezone_invalid",
  "vendor_error_dnc",
  "vendor_error_litigator",
  "vendor_error_mobile_line",
  "vendor_error_not_configured",
  "circuit_open_dnc",
  "circuit_open_litigator",
  "phone_missing",                // for phone-less contacts (see §11 note on real-data 34% phone-missing)
] as const;
export type ReasonCode = typeof REASON_CODES[number];
```

The wire format is: `reasons: string[]` where each string is one of these codes. When a code needs qualifying data (which state, which vendor, which holiday name), that data goes in a parallel field:

```ts
reasonDetails?: Partial<Record<ReasonCode, unknown>>;  // optional, only when a reason needs qualifying
```

Example: `reasons: ["state_dnc", "holiday_federal"], reasonDetails: { state_dnc: { state: "NY" }, holiday_federal: { name: "christmas" } }`.

This is the single source of truth. §7.1, §7.2, §9, §10 Gate 2, and §11 all reference REASON_CODES rather than duplicating the list. Contract tests in Agent A and Agent B assert that every `reasons[]` value they observe is a member of REASON_CODES.

### 7.1 `POST /api/compliance/scrub`

**Body:**
```ts
{
  phones: string[];            // E.164
  contactPhoneIds?: string[];  // optional; when provided, results are keyed to phones but ScrubLog rows carry contactPhoneId
}
```

**Response 200:**
```ts
{
  results: Array<{
    phone: string;
    callable: boolean;
    reasons: ReasonCode[];
    reasonDetails?: Partial<Record<ReasonCode, unknown>>;
  }>;
  scrubbedAt: string;    // ISO
}
```

**Fail-closed:** any per-phone error → that phone gets `callable: false, reasons: ["vendor_error_dnc"]` (or the appropriate error code). Any transaction-level error → the WHOLE response is `500` (do not partially succeed). Emits `scrub.completed` on success.

### 7.2 `POST /api/compliance/callable-now`

**Body:**
```ts
{
  contactPhoneIds: string[];   // MAX 100 items per request
  atInstant?: string;          // ISO; defaults to server now (UTC)
}
```

**Batch cap:** `contactPhoneIds.length` MUST be `<= 100`. If exceeded, respond with HTTP **413 Payload Too Large** and body `{ error: "batch_too_large", maxItems: 100, receivedItems: <n> }`. This cap is published in `contracts/http/compliance-callable-now.json` with `maxItems: 100` on `contactPhoneIds`. Agent A's mock also enforces this — the two must match at integration.

**Response 200:**
```ts
{
  results: Array<{
    contactPhoneId: string;      // echo of input
    phone: string;                // E.164 resolved from ContactPhone row; empty string if row missing
    callable: boolean;
    reasons: ReasonCode[];
    reasonDetails?: Partial<Record<ReasonCode, unknown>>;
  }>;
}
```

**Response-shape lock (planner-ratified):** the per-result object contains BOTH `contactPhoneId` and `phone`. Agent A consumes `phone` for logging; Agent B consumes `contactPhoneId` to correlate against the DialSession queue. When the ContactPhone row is missing (phone_missing case), `phone` is the empty string `""` and `contactPhoneId` echoes the input.

**Fail-closed semantics** are load-bearing. This endpoint is called INLINE by Agent B before every dial. On ANY error (DB down, contact not found, timezone missing, vendor cache miss + live lookup fails, tz db missing zone, JSON parse error, invalid contactPhoneId format) — return per-id `callable: false` with a reason from REASON_CODES. If the whole endpoint 500s, Agent B is required to treat that as `callable: false` — but it's your job to make sure that happens rarely.

**Latency budget — hot path.** `callable-now` is called inline by Agent B before every dial (potentially 3 concurrent legs; several hundred calls/hour under power dialing). Target **p95 < 150ms, p99 < 300ms** for the M1 pipeline (before vendor calls) and **p95 < 400ms, p99 < 800ms** for the M2 pipeline (after vendor calls, with 24h read-through cache warm). Achieve by:

- In-process LRU/TTL caches (5-minute TTL, invalidated on `POST /api/compliance/policy/confirm`):
  - `CallingWindowConfig` by (orgId, timezone).
  - Policy-confirmed gate result by (orgId, timezone).
  - Today's holiday set by (orgId, localDate, state).
- Batch loading: when N contactPhoneIds arrive, do ONE Prisma `findMany` across ContactPhone (join Contact) — never N queries.
- Vendor step (M2) hits `DncSuppression` first as the read-through cache before hitting live vendor.

Add `callableNow.perf.spec.ts` under `src/lib/compliance/__tests__/scrub/` that runs 100 warm-cache calls against seeded fixtures and asserts p95 latency.

### 7.3 `GET /api/compliance/dnc/suppressions?phone=E164`

**Response 200:** `{ phone, suppressions: [{ source, addedAt, addedBy, reason }] }`.

### 7.4 `POST /api/compliance/dnc/internal`

**Body:** `{ phone: string /* E.164 */, reason?: string, addedBy?: string }`.

**Response 201:**
```ts
{
  id: string;         // DncSuppression.id
  phone: string;      // E.164, normalized
  source: "internal";
  addedAt: string;    // ISO
  added: boolean;     // true if new row created; false if already existed (idempotent)
}
```

**Idempotency:** if `(organizationId, phone, source="internal")` already exists, return the existing row with HTTP **201** and `added: false`. If new, `added: true`. Response body has the same fields either way. This shape is consumed by Agent D on SMS STOP handling — `added` is used for D's telemetry (distinguishing new opt-outs from re-observations).

### 7.5 `POST /api/compliance/policy/confirm`

**Body:**
```ts
{
  timezone: string;              // IANA
  earliestHour: number;          // 0-23
  latestHour: number;            // 0-24, must be > earliestHour
  allowedDaysOfWeek: number[];   // subset of [0..6]
  policyConfirmedBy: string;     // structured: "user:<email>|counsel:<name>|date:<YYYY-MM-DD>"; min length 20 chars
}
```

**Response 201:** the created/updated CallingWindowConfig row with `policyConfirmedAt` set to now. Also **invalidates the in-process policy/config LRU cache** so the next `callable-now` sees the change.

Validate: `earliestHour >= 0`, `latestHour <= 24`, `earliestHour < latestHour`, `policyConfirmedBy.length >= 20`. Timezone must be a valid IANA identifier — probe by constructing `new Intl.DateTimeFormat('en-US', { timeZone: input })` in a try/catch; on throw, return 400.

### 7.6 `GET /api/compliance/policy/status`

**Response 200:** `{ configs: Array<{ timezone, earliestHour, latestHour, allowedDaysOfWeek, policyConfirmedBy: string | null, policyConfirmedAt: string | null }>, unconfirmedTimezones: string[] }`.

`unconfirmedTimezones` includes every IANA timezone that appears on any Contact but has no CallingWindowConfig row OR has a row with null `policyConfirmedBy`. Computed via a Prisma SELECT DISTINCT on Contact.timezone LEFT JOIN CallingWindowConfig.

### 7.7 `GET /api/compliance/health`

Returns `{ status: "ok", dbLatencyMs, holidayTableFreshDays, dncVendorReachable: boolean | "not-configured", litigatorVendorReachable: boolean | "not-configured", circuitState: { dnc: "closed" | "open", litigator: "closed" | "open" } }`.

If `holidayTableFreshDays > 7`, log a Sentry warning (not error). If `> 40`, log a Sentry error. This is the early-warning signal Ryan needs to notice a silently-failing cron before the 40-day fail-closed threshold trips.

### 7.8 `GET /api/cron/dnc-refresh`

**Header:** `Authorization: Bearer <CRON_SECRET>`. Reject with 401 if missing/wrong.

Full nightly re-scrub of ALL ContactPhone rows against federal + state DNC vendor. Batched (100-500 per vendor call). Upserts DncSuppression rows for hits. Removes rows where `source` is `federal` or `state:*` and the phone is no longer on the list (internal DNC never gets removed by cron).

### 7.9 `GET /api/cron/holiday-refresh`

**Header:** `Authorization: Bearer <CRON_SECRET>`.

Uses `date-holidays` npm package. For federal (US) and each of the 50 states + DC + PR, generate current year through +12 months of holidays. Upsert HolidaySuppressionDate rows (unique on `organizationId, date, scope`). Never delete past dates — audit trail.

### 7.10 `POST /api/compliance/circuit/resume`

**Header:** `Authorization: Bearer <CRON_SECRET>`. Reject with 401 if missing/wrong.

**Body:**
```ts
{
  circuit: "dnc" | "litigator" | "all";
  operatorLabel: string;  // free-form audit label, e.g. "ryan@dealflow 2026-09-04 verified vendor status page green"
}
```

**Response 200:** `{ circuits: [{ name: "dnc", state: "closed", resumedAt: string }, ...] }`.

Resets the in-process circuit-breaker for the named vendor(s). Writes a ScrubLog row with `operation="check-federal"` (or `check-litigator`) and `result="clean"`, `detail={ event: "circuit_resumed", operatorLabel, correlationId }`. Subsequent scrub requests will attempt live vendor calls again.

### Cross-slice endpoints Agent C consumes

**None at runtime.** Runtime cross-slice data access is Prisma SELECT on shared DB (§2 read-only tables). During tests and dev boot you consume mocks under `contracts/mocks/**` for anything you'd normally read (fixture Contact/ContactPhone/Lead/ImportBatch rows).

---

## 8. Repository layout + worktree setup

Ryan has already scaffolded the repo. From the parent directory that contains `dealflow-crm/`:

```bash
cd dealflow-crm
git worktree add worktrees/agent-compliance agent-compliance
cd worktrees/agent-compliance
```

You will spend the entire build in `worktrees/agent-compliance` on branch `agent-compliance`. Never share HEAD across executors.

**Sync contract changes into your worktree:**
```bash
git fetch origin && git rebase origin/main
```
Do this at the start of every session, and immediately after any planner announcement of a contract change.

**iCloud landmine.** The repo lives in iCloud Drive. iCloud silently duplicates files as ` 2.ts`, ` 2.tsx`, etc., which will fool grep-based audits and cause `tsc` to compile stale copies. Guard steps:
```bash
# At the start of every session:
find . -type f \( -name "* 2.ts" -o -name "* 2.tsx" -o -name "* 2.json" \) -not -path "./node_modules/*" -not -path "./.next/*" -print
# If anything prints, delete them:
find . -type f \( -name "* 2.ts" -o -name "* 2.tsx" -o -name "* 2.json" \) -not -path "./node_modules/*" -not -path "./.next/*" -delete
```
Also purge `.next/` before every `tsc` / `pnpm build`.

**Files this slice creates.**

```
src/lib/compliance/
├── index.ts                       # public API surface for the slice (re-exports REASON_CODES)
├── env.ts                         # zod-validated env parsing (Doppler)
├── db.ts                          # Prisma client wrapper w/ correlationId propagation
├── logger.ts                      # pino child logger
├── correlation.ts                 # correlationId middleware helpers
├── caches.ts                      # in-process LRU/TTL caches for hot path
├── events/
│   └── emitScrubCompleted.ts      # NOTIFY crm_scrub inside tx
├── timezone/
│   ├── tzResolve.ts               # contact -> IANA tz (Contact.timezone read; NO fallback)
│   ├── stateFromTimezone.ts       # IANA tz + Contact address state -> canonical US state code
│   ├── windowCheck.ts             # main callable-window evaluator (DST-aware)
│   └── tzStateMap.ts              # IANA -> [US state codes] many-to-many table
├── holidays/
│   ├── refresh.ts                 # cron worker; date-holidays -> HolidaySuppressionDate
│   ├── check.ts                   # (org, localDate, contactState?) -> {blocked, reason?}
│   └── stateHolidays.ts           # config: which states we track
├── policy/
│   ├── confirm.ts                 # writes CallingWindowConfig; sets policyConfirmedAt
│   ├── status.ts                  # aggregates unconfirmed timezones
│   └── gate.ts                    # THE policy-confirmed gate; used everywhere
├── dnc/
│   ├── check.ts                   # single-phone federal/state/internal check
│   ├── internal.ts                # add/read internal DNC
│   ├── refresh.ts                 # cron worker: full re-scrub
│   └── vendors/
│       ├── index.ts               # factory keyed by DNC_VENDOR env
│       ├── types.ts               # DncVendorClient interface (batched API)
│       ├── possiblenow.ts
│       ├── contactCenterCompliance.ts
│       ├── dncCom.ts
│       ├── tcpaShield.ts
│       └── noop.ts                # returns fail-closed sentinel; NOT "clean pass"
├── litigator/
│   ├── check.ts
│   ├── refresh.ts
│   └── vendors/
│       ├── index.ts
│       ├── types.ts
│       ├── blacklistAlliance.ts
│       ├── tcpaShield.ts
│       ├── litigatorScrub.ts
│       └── noop.ts
├── mobileLine/
│   ├── check.ts
│   └── twilioLookup.ts
├── scrub/
│   ├── scrubPhones.ts             # bulk pipeline
│   ├── callableNow.ts             # per-contactPhoneId real-time pipeline
│   └── scrubLog.ts                # ScrubLog append helper (createMany)
├── bulk/
│   ├── worker.ts                  # pg-boss job: bulk scrub 25k phones by importBatchId
│   ├── checkpoint.ts              # BulkScrubCheckpoint read/write
│   └── circuitBreaker.ts          # vendor-failure circuit + exponential backoff
└── errors.ts                      # typed errors: VendorError, TimezoneUnresolvedError, PolicyUnconfirmedError

src/app/api/compliance/
├── scrub/route.ts
├── callable-now/route.ts
├── dnc/
│   ├── suppressions/route.ts
│   └── internal/route.ts
├── policy/
│   ├── confirm/route.ts
│   └── status/route.ts
├── circuit/
│   └── resume/route.ts
└── health/route.ts

src/app/api/cron/
├── dnc-refresh/route.ts
└── holiday-refresh/route.ts

contracts/http/
├── compliance-reasons.ts          # REASON_CODES frozen vocabulary (§7A)
├── compliance-callable-now.json   # OpenAPI shape w/ maxItems:100 on contactPhoneIds
├── compliance-scrub.schema.ts     # Zod for scrub endpoint
└── compliance-dnc-internal.schema.ts # Zod for internal DNC endpoint

contracts/events/
└── scrub.completed.ts             # Zod schema

contracts/mocks/compliance/
├── fixtures/
│   ├── contacts.json              # canned Contact+ContactPhone rows across US timezones (see §10 for exact IDs)
│   ├── phones-blocked.json        # canned federal/state/litigator matches
│   ├── holidays.json              # canned date-holidays output snapshot
│   ├── import-batches.json        # canned ImportBatch rows for bulk-scrub tests
│   └── twilio-lookup.json         # canned line-type responses
├── vendors/
│   ├── mockDnc.ts
│   ├── mockLitigator.ts
│   └── mockTwilioLookup.ts
└── server.ts                      # optional standalone mock server

contracts/tests/compliance/
├── scrub.contract.spec.ts
├── callable-now.contract.spec.ts
├── callable-now.batch-cap.spec.ts # 413 on >100 items
├── dnc-internal.contract.spec.ts  # verifies `added: boolean` field
├── policy.contract.spec.ts
├── circuit-resume.contract.spec.ts
├── event-scrub-completed.spec.ts
├── mocks-faithful.spec.ts
└── failClosed.spec.ts             # exhaustive per-error-mode -> callable:false

src/lib/compliance/__tests__/
├── timezone/
│   ├── windowCheck.dst.spec.ts
│   ├── windowCheck.dow.spec.ts
│   ├── stateFromTimezone.spec.ts
│   └── tzResolve.spec.ts
├── holidays/
│   ├── check.spec.ts
│   └── refresh.spec.ts
├── policy/
│   ├── confirm.spec.ts
│   ├── gate.spec.ts
│   └── status.spec.ts
├── dnc/
│   ├── check.spec.ts
│   ├── internal.spec.ts
│   └── refresh.spec.ts
├── litigator/
│   └── check.spec.ts
├── mobileLine/
│   ├── check.spec.ts
│   └── twilioLookup.spec.ts
├── scrub/
│   ├── scrubPhones.spec.ts
│   ├── callableNow.spec.ts
│   ├── callableNow.perf.spec.ts   # p95 latency budget
│   └── scrubLog.spec.ts
├── bulk/
│   ├── worker.spec.ts
│   ├── worker.perf.spec.ts        # 25k phones in < 30 min
│   ├── checkpoint.spec.ts         # resumable from BulkScrubCheckpoint
│   └── circuitBreaker.spec.ts
└── events/
    └── emitScrubCompleted.spec.ts

scripts/
├── seed-compliance-fixtures.ts    # populate local DB with contacts (specific IDs, see §10)
├── restore-from-backup.ts
└── run-isolation-boot.sh          # Gate 1 boot command
```

---

## 9. Milestones + implementation plan

The strategy is: **prove the policy-fail-closed math is right BEFORE touching any vendor.** Vendor selection is a blocker outside your control. The window/holiday/policy layer is the legal fail-safe and the coverage floor is 95%. Front-load it.

### Milestone 0 — Scaffolding (day 1-2)

**Goal:** slice compiles, DB migrates, health endpoint returns 200.

**Files:**
- `prisma/schema.prisma` — add the 7 tables verbatim from §5 (including `BulkScrubCheckpoint`).
- `contracts/http/compliance-reasons.ts` — REASON_CODES.
- `contracts/http/compliance-callable-now.json` — OpenAPI stub with `maxItems: 100` on `contactPhoneIds`.
- `contracts/http/compliance-dnc-internal.schema.ts` — Zod for internal DNC endpoint (includes `added: boolean`).
- `src/lib/compliance/env.ts` — Zod schema for env vars. `DNC_VENDOR` and `LITIGATOR_VENDOR` are `.optional()` until M2. `MOBILE_LINE_VENDOR` defaults to `"twilio_lookup"`.
- `src/lib/compliance/db.ts` — Prisma client with correlationId in log context.
- `src/lib/compliance/logger.ts` — pino child logger.
- `src/lib/compliance/correlation.ts` — middleware helper.
- `src/lib/compliance/caches.ts` — LRU/TTL cache primitives (use `lru-cache` npm package, no Redis).
- `src/lib/compliance/errors.ts` — typed error classes.
- `src/app/api/compliance/health/route.ts`.

**Commands:**
```bash
pnpm install
pnpm dlx doppler run -- npx prisma migrate dev --name compliance-tables
npx prisma generate
pnpm exec tsc --noEmit
pnpm exec vitest run
```

**Ryan's dotenv rule.** Any script under `scripts/` that touches Prisma MUST have `import 'dotenv/config'` as the FIRST line. Even under Doppler, keep the import.

**Proof of done:**
- `pnpm exec tsc --noEmit` green.
- `curl -H 'x-correlation-id: t' localhost:3000/api/compliance/health` returns `{ status: "ok", ... }`.

---

### Milestone 1 — The fail-closed core: timezone + calling window + holiday + policy gate

**This is the most important milestone in the entire slice.** Everything downstream trusts this to be right. Coverage floor for these files: **95%.**

#### 1a — Timezone resolution + tz-to-state mapping (day 2-3)

**Files:**
- `src/lib/compliance/timezone/tzResolve.ts`
  - Input: `contactId`. Reads `Contact.timezone` via Prisma SELECT. If null/empty/whitespace → throws `TimezoneUnresolvedError`. **No default. No fallback to `NYC_TIMEZONE_DEFAULT`.** This is deliberate and load-bearing: Agents A and D may apply a display-layer fallback of `America/New_York` for null-tz contacts, but that fallback does NOT reach here — this function reads the raw DB column.
- `src/lib/compliance/timezone/tzStateMap.ts`
  - Many-to-many static map for holiday-scope resolution ONLY (never for window-check). Conservative (broad) buckets are intentional — over-blocking is fail-closed-correct. Ryan-facing README (§14) notes the broadness and lists exact buckets so Ryan can review and prune before ship.
- `src/lib/compliance/timezone/stateFromTimezone.ts`
  - Prefers the contact's ADDRESS state when available (Agent A stores addresses on Lead as JSON array `[{state, ...}, ...]`; SELECT via Contact.leadId → Lead.addresses, take `addresses[0].state` when Lead.primaryAddressFull is set, else null). Falls back to the coarser tz-bucket only for holiday scope resolution. Returns `null` if neither is derivable.

**Tests:**
- `tzResolve` returns tz when present; throws when missing/whitespace/invalid; never returns `NYC_TIMEZONE_DEFAULT`.
- `stateFromTimezone` prefers address state; falls back correctly; returns `null` if neither is derivable.

#### 1b — Calling-window evaluator with DST (day 3-5)

**File:** `src/lib/compliance/timezone/windowCheck.ts`

**Signature:**
```ts
export function evaluateCallingWindow(input: {
  atInstant: Date;            // UTC
  timezone: string;           // IANA
  earliestHour: number;
  latestHour: number;
  allowedDaysOfWeek: number[];
}): { allowed: boolean; localHour: number; localDayOfWeek: number; localDate: string /* YYYY-MM-DD */; reason?: "outside_calling_window_hour" | "outside_calling_window_day" | "timezone_invalid" };
```

**Implementation notes:**
- Use `Intl.DateTimeFormat` with `timeZone: input.timezone`, `hour: '2-digit'`, `weekday: 'short'`, `year/month/day: 'numeric'`, `hourCycle: 'h23'`. This is DST-aware natively via Node 22's bundled ICU. Do NOT bundle `@js-temporal/polyfill` — Node 22 LTS includes full IANA tz db via ICU by default, verified adequate for continental US + Alaska + Hawaii + PR zones.
- Never use `Date.prototype.getHours()`, `getDay()`, or `getDate()` for any decision. Those pull the SERVER timezone. This is the ONLY file in the slice permitted to convert UTC → local.
- If `Intl.DateTimeFormat` throws (invalid tz) → return `{ allowed: false, reason: "timezone_invalid", localHour: -1, localDayOfWeek: -1, localDate: "" }`.
- Range check: `localHour >= earliestHour && localHour < latestHour`. Note: `latestHour: 20` means the last acceptable call-start local time is 19:59.

**DST test matrix (`windowCheck.dst.spec.ts`) — frozen expected outputs:**

- **Spring forward, nonexistent local time.** `America/New_York`, 2027-03-14. UTC instant `2027-03-14T06:30:00Z` corresponds to local wall-clock `02:30` in the skipped hour. **Frozen expectation:** Node 22's `Intl.DateTimeFormat` will format this instant as local `03:30` EDT (the offset applied at that UTC instant is UTC-4, since DST is already in effect at `06:30Z`). Test asserts `localHour === 3`. This is the deterministic, spec-frozen result — do not rely on the "nonexistent local wall-clock" interpretation; the input is a UTC instant, and Intl always renders it correctly.
- **Fall back, ambiguous local time.** `America/New_York`, 2026-11-01. UTC instants `2026-11-01T05:30:00Z` (before rollback, EDT UTC-4) → local `01:30` EDT. UTC instant `2026-11-01T06:30:00Z` (after rollback, EST UTC-5) → local `01:30` EST. Test asserts both instants produce `localHour === 1` (both blocked by default earliestHour=9, so both `allowed: false, reason: "outside_calling_window_hour"`). Verifies the evaluator handles the ambiguous local hour deterministically per-instant.
- **Arizona no-DST.** `America/Phoenix`, UTC `2027-03-14T14:00:00Z` and `2027-11-07T14:00:00Z` — both yield the same local hour (07:00 MST year-round). Assert `localHour === 7` both times.
- **Cross-state contact:** contact tz `America/Chicago`, Lead address state `IN`. Window check uses `Contact.timezone` (Chicago), not address state. Assert.
- **Invalid IANA zone:** input `"Etc/Weird"` → `{ allowed: false, reason: "timezone_invalid" }`, no throw.

**DoW test matrix (`windowCheck.dow.spec.ts`):**
- Default `[1,2,3,4,5]` blocks Saturday (6) with `reason: "outside_calling_window_day"` and Sunday (0) same.
- Confirm 0=Sunday convention consistently.
- New Year's Day 2027 falls on Friday — window-check alone would allow; holiday layer must block (that's Milestone 1c).

#### 1c — Holiday suppression (day 5-7)

**Files:**
- `src/lib/compliance/holidays/refresh.ts`
  - Uses `date-holidays` npm package. For federal (`hd = new Holidays('US')`) and each state (`hd = new Holidays('US', '<XX>')`), fetch current year + next year holidays. Upsert `HolidaySuppressionDate` with `scope='federal'` or `scope='state:XX'`. Idempotent on `(organizationId, date, scope)`.
- `src/lib/compliance/holidays/check.ts`
  - Input: `{ orgId, localDate: 'YYYY-MM-DD', contactState: string | null, contactTimezone: string }`.
  - Query HolidaySuppressionDate rows for that date across scope IN `('federal', 'state:XX')` where `XX` is the contact's derived state. If `contactState` is null, ALSO include all state-scopes for states in the contact's tz-bucket (broader, more restrictive — fail-closed).
  - Returns `{ blocked: boolean, reason?: "holiday_federal" | "holiday_state" | "holiday_table_stale", detail?: { name?: string, state?: string } }`.
- `src/lib/compliance/holidays/stateHolidays.ts`
  - Config: all 50 + DC + PR.
- `src/app/api/cron/holiday-refresh/route.ts`
  - Bearer `CRON_SECRET` check. Calls `refresh.ts`.
  - Health endpoint surfaces staleness (§7.7); Sentry warns at >7 days, errors at >40 days.

**Tests (`check.spec.ts`, `refresh.spec.ts`):**
- MLK Day, Presidents Day, Memorial Day, Juneteenth, July 4, Labor Day, Columbus/Indigenous Peoples Day, Veterans Day, Thanksgiving, Day after Thanksgiving, Christmas Eve, Christmas Day, New Year's Day.
- Federal blocks all contacts regardless of state.
- State-specific (Patriots' Day MA) blocks only that state's contacts.
- If HolidaySuppressionDate newest `createdAt` > 40 days old → `check` returns `{ blocked: true, reason: "holiday_table_stale" }`.

#### 1d — Policy-confirmation gate (day 7-8)

**Files:**
- `src/lib/compliance/policy/gate.ts`
  - `isPolicyConfirmed(orgId, timezone): Promise<{ confirmed: boolean; config?: CallingWindowConfig }>`.
  - No CallingWindowConfig row → `{ confirmed: false }`.
  - Row exists, `policyConfirmedBy IS NULL` → `{ confirmed: false }`.
  - Row confirmed → `{ confirmed: true, config }`.
  - Uses LRU cache from `caches.ts`.
- `src/lib/compliance/policy/confirm.ts` — endpoint handler. Invalidates LRU cache on write.
- `src/lib/compliance/policy/status.ts` — endpoint handler.
- Routes: `src/app/api/compliance/policy/{confirm,status}/route.ts`.

**Tests (`gate.spec.ts`):**
- Empty CallingWindowConfig → all timezones unconfirmed → all callable checks return false, reason `"policy_unconfirmed"`.
- Row exists but null `policyConfirmedBy` → unconfirmed.
- Row confirmed → confirmed.
- Confirm endpoint validates `earliestHour < latestHour`, rejects invalid IANA with 400, rejects `policyConfirmedBy.length < 20` with 400.
- Cache invalidation: confirm → next `isPolicyConfirmed` sees new row without waiting for TTL.

#### 1e — Wire the `callable-now` pipeline against Milestone 1 pieces only (day 8-9)

**File:** `src/lib/compliance/scrub/callableNow.ts`.

The M1 pipeline (no vendors yet):

1. **Batch cap check:** if `contactPhoneIds.length > 100`, return HTTP 413 immediately.
2. **Batch load** ContactPhone rows via `findMany({ where: { id: { in: ids } }, include: { contact: true } })`. Missing row → `callable: false, reasons: ["phone_missing"], phone: ""`.
3. For each ContactPhone: read `contact.timezone`. Missing/whitespace → `callable: false, reasons: ["timezone_unresolved"], phone: <resolved>`. ScrubLog `check-window` result `error`.
4. `isPolicyConfirmed(orgId, tz)`. Unconfirmed → `callable: false, reasons: ["policy_unconfirmed"]`. ScrubLog `check-window` result `error`.
5. Internal DNC check (`DncSuppression` where `source='internal'`). Match → `callable: false, reasons: ["internal_dnc"]`. ScrubLog `check-internal` result `blocked`.
6. `evaluateCallingWindow(atInstant, tz, config)`. Not allowed → `callable: false, reasons: ["outside_calling_window_hour"]` or `["outside_calling_window_day"]`. ScrubLog `check-window` result `blocked`.
7. Holiday check on the LOCAL date. Blocked → `callable: false, reasons: ["holiday_federal"]` (with `reasonDetails.holiday_federal = { name }`) or `["holiday_state"]` (with `{ state, name }`). ScrubLog `check-holiday` result `blocked`.
8. Otherwise → `callable: true, reasons: []`. ScrubLog `check-window` result `clean`.

Every per-result object emits BOTH `contactPhoneId` (echoed) and `phone` (resolved from row, or `""` when the row is missing).

Emit `scrub.completed` when finishing the batch.

**Milestone 1 proof-of-done:**
- Coverage on `timezone/**`, `holidays/**`, `policy/**`, `scrub/callableNow.ts`: **≥ 95%.**
- `callableNow.perf.spec.ts` p95 < 150ms warm-cache.
- `callable-now.batch-cap.spec.ts` — request with 101 contactPhoneIds returns HTTP 413.
- Gate 1 (see §10) is passable for callable-now with `DNC_VENDOR` unset, because vendors aren't in the pipeline yet at M1.

---

### Milestone 2 — Vendor integrations

**BLOCKING:** if `DNC_VENDOR` and `LITIGATOR_VENDOR` are not yet chosen by Ryan when you reach this milestone, STOP and message the planner. Do not proceed with a guessed vendor.

The `noop` vendor's behavior is: "vendor not configured → return errored batch → all phones callable:false with reason `vendor_error_not_configured`." That's a fail-closed sentinel, not a clean pass.

#### 2a — Vendor client interface (day 10-11)

**File:** `src/lib/compliance/dnc/vendors/types.ts`

```ts
export interface DncVendorClient {
  readonly name: string;
  readonly batchSize: number;
  readonly rateLimitPerSec: number;
  scrubBatch(phones: string[], opts: { correlationId: string }): Promise<{
    perPhone: Array<{ phone: string; onList: boolean; list: string /* federal|state:XX */; vendorMatchId?: string }>;
    checkedAt: string;
  }>;
}
```

**File:** `src/lib/compliance/dnc/vendors/index.ts` — factory keyed by `DNC_VENDOR` env. Unknown/missing → returns `noop` client.

Litigator mirrors the same pattern.

**Vendor 404 / non-2xx policy.** Until a real vendor is chosen and its response semantics are documented, treat **every non-2xx** as a vendor error → fail-closed. Do not implement per-vendor "404 = clean" mappings. When Ryan picks a vendor at M2 start, executor writes `src/lib/compliance/dnc/vendors/<name>.status-codes.ts` documenting exactly which codes are treated as `clean`, which as `on-list`, and which as `vendor_error_dnc`. Planner reviews the mapping before it ships.

#### 2b — Federal + state DNC (day 11-13)

- `src/lib/compliance/dnc/check.ts` — single-phone check with 24h read-through cache (query DncSuppression first; if absent AND last check via ScrubLog < 24h AND clean → clean; else live vendor call).
- `src/lib/compliance/dnc/refresh.ts` — nightly full re-scrub cron worker.
- Route: `src/app/api/cron/dnc-refresh/route.ts` — bearer + circuit breaker.

**Fail-closed rules:**
- Vendor throws / times out (10s) / returns malformed / any non-2xx → those phones emit `callable:false` with `["vendor_error_dnc"]`. ScrubLog `check-federal` result `error`.
- Cache is NEVER a substitute for a required live check; for callable-now path a 24h read-through cache is acceptable per spec.

#### 2c — Internal DNC (day 13-14)

- `src/lib/compliance/dnc/internal.ts`
  - Adds `DncSuppression { source: 'internal', addedBy, reason }`.
  - Idempotent — unique on `(organizationId, phone, source)`.
  - Returns `{ id, phone, source: "internal", addedAt, added: boolean }` where `added=true` for new inserts, `added=false` for pre-existing rows (see §7.4).
- Route: `src/app/api/compliance/dnc/internal/route.ts`.

**Consumer note.** Agent D calls this endpoint on SMS STOP handling (confirmed with planner; D's earlier fallback event-based path is NOT to be used). D uses the `added` field for telemetry — distinguishing new opt-outs from re-observations of already-suppressed numbers.

**Critical test (`internal.spec.ts`):**
- Add internal DNC for `+15555550101` → assert `added: true`.
- Re-add same phone → assert `added: false`, HTTP 201, `id` matches original row.
- Simulate DealFlow re-import: run a mock import that writes new ContactPhone rows for `+15555550101` (direct Prisma writes to Contact/ContactPhone in the shared DB, since Agent A's Prisma client is the same).
- Re-run scrub for that phone.
- Assert `callable: false` with reason `internal_dnc`.
- Assert the internal DncSuppression row is still present, unchanged.

#### 2d — Litigator scrub (day 14-15)

- `src/lib/compliance/litigator/check.ts`, `.../refresh.ts`, vendors.
- 30-day cache TTL.
- Wire into `scrubPhones` pipeline AFTER DNC.

#### 2e — Mobile-line identification via Twilio Lookup (day 15-16)

- `src/lib/compliance/mobileLine/twilioLookup.ts` — uses `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` against `https://lookups.twilio.com/v2/PhoneNumbers/{E164}?Fields=line_type_intelligence`.
- `src/lib/compliance/mobileLine/check.ts`:
  - Read `MobileLineCache` for `(orgId, phone)`.
  - Row exists, not expired → return `{ lineType, carrier, stale: false }`.
  - Row exists, expired → live lookup. On success: upsert. On error: return the stale row with `stale: true` — treated as **advisory clean, not error**.
  - No row → live lookup. On success: upsert with `expiresAt = now + 90d`. On error: **treated as advisory error, NOT fail-closed** (see decision below).

**Mobile-line advisory-vs-blocking decision (resolves prior contradiction).** For MVP, mobile-line is **advisory only**. A Twilio Lookup error does NOT append a reason to the callable-now response; it does write a ScrubLog `check-mobile-line` row with `result="error"` and `detail={ error }`. The reason code `vendor_error_mobile_line` EXISTS in REASON_CODES but is currently only produced by a future stricter-mode CallingWindowConfig extension (not shipped in this brief). Test asserts: mobile-line vendor failure alone never flips `callable` to false.

The failure-mode table in §11 is corrected accordingly.

#### 2f — Wire full `scrubPhones` pipeline (day 16-17)

**File:** `src/lib/compliance/scrub/scrubPhones.ts`.

**Single canonical runtime order (no earlier ordered-list — this is the only order that ships):**

1. Policy-confirmation gate (per-tenant + per-timezone). If no confirmed config for the tenant's timezone set at all → short-circuit ALL phones to `callable: false, reasons: ["policy_unconfirmed"]` before spending vendor $.
2. Internal DNC (DB-only, fast).
3. Federal DNC (with 24h read-through cache).
4. State DNC (with 24h read-through cache).
5. Litigator (with 30-day cache).
6. Calling-window (per contact; requires contactPhoneIds mapping).
7. Holiday check.
8. Mobile-line lookup runs **in parallel, out-of-band**, advisory only. Errors write ScrubLog with `result="error"` but do NOT append to `reasons[]`. Successes upsert `MobileLineCache`.

Every ScrubLog row is written. Every `scrub.completed` event is emitted in the same DB tx.

#### 2g — Bulk-scrub worker for 25k initial-load (day 17-19)

**File:** `src/lib/compliance/bulk/worker.ts`.

- Enqueued by Agent A's importer via a `pg-boss` job named `compliance:bulk-scrub`.
- Payload: `{ importBatchId: string, correlationId: string }`.
- **Enumeration:** SELECT ContactPhones by joining `Lead.source = "import:" + importBatchId` → Contact → ContactPhone. **This convention is planner-locked as an Agent A commitment (§12 pre-authorized change #5).** If `Lead.source` convention is not documented in `CONTRACTS.md` when you start this milestone, STOP and message planner (see §2 note).
- Chunks into vendor-batch-sized groups (default 250). Respects `rateLimitPerSec`.
- **Checkpoint via `BulkScrubCheckpoint` table.** On start of each chunk, UPDATE `BulkScrubCheckpoint` (orgId, importBatchId) with `lastProcessedContactPhoneId`, `chunkIndex`, `processedCount`. On resume, SELECT the row and continue from `lastProcessedContactPhoneId + 1` (order by ContactPhone.id ascending — stable cuid order).
- Circuit-breaker (`bulk/circuitBreaker.ts`): if vendor error rate > 20% over rolling 5-min window, HALT. Set `BulkScrubCheckpoint.status="halted"`, `haltReason="circuit_open_dnc"`. Health endpoint surfaces halt state. Resume via `POST /api/compliance/circuit/resume` (see §7.10), then re-enqueue the pg-boss job.
- **Perf target: 25k phones end-to-end in < 30 minutes** at 250/call × 5 calls/sec.

**Prisma perf gotcha (Ryan-specific):** do NOT loop `await prisma.scrubLog.create()` — 25k × 90ms = 37.5 min alone. Use `prisma.scrubLog.createMany({ data, skipDuplicates: true })` per chunk. Chunked transactions via `prisma.$transaction([...])`.

**Test (`worker.perf.spec.ts`):** mock vendor returns canned batches with 50ms/batch of 250 (jittered). Assert p95 batch latency + total wall-clock < 30 min.

**Phone-less contact handling.** From SHARED_CONTEXT §8: real Mojo data is ~66% phone-populated, ~34% phone-missing. The bulk worker SELECT should filter `WHERE contactPhone.phone IS NOT NULL` at query time and log a metric (`phonesSkippedMissing`) in `BulkScrubCheckpoint.status` detail. Do NOT emit `phone_missing` reasons for phones you never enumerated — that reason is only for the case where Agent B passes a `contactPhoneId` that resolves to a row with a null phone (which shouldn't happen but fail-closed anyway).

---

### Milestone 3 — Contract tests + Gate hardening (day 20-22)

- `contracts/tests/compliance/*.spec.ts` — see §10 Gate 2.
- `contracts/mocks/compliance/**` — mockDnc, mockLitigator, mockTwilioLookup, fixture Contact set spanning US timezones + DST edges (specific IDs in §10).
- Standalone isolation-boot script `scripts/run-isolation-boot.sh`.
- Coverage sweep and CI wiring.

---

## 10. The three acceptance gates

Adapted from SHARED_CONTEXT §11 with Agent C's critical paths, coverage floor, and exact isolation-boot command. **CI runs all three. Slice does not enter integration RED.**

### Gate 1 — Runs in isolation

The slice boots on its own, connects only to its own tables (plus read-only SELECTs against fixture-populated Agent A tables in the same DB), and responds to requests, with EVERY external vendor mocked and NO other agent's runtime code present.

**Exact boot command:**
```bash
# From worktrees/agent-compliance
pnpm exec doppler run -- bash scripts/run-isolation-boot.sh
```

`scripts/run-isolation-boot.sh` does:
1. `find` iCloud duplicate `* 2.ts*` files and abort if any exist.
2. `rm -rf .next`.
3. `npx prisma migrate deploy` against Railway dev DB (Ryan's preference per project memory; document local docker Postgres as alternative in README).
4. Seed compliance fixtures: `pnpm exec tsx scripts/seed-compliance-fixtures.ts`.
5. Set `DNC_VENDOR=mock LITIGATOR_VENDOR=mock` — factory loads `contracts/mocks/compliance/vendors/mockDnc.ts`.
6. `pnpm dev` on port 3000.
7. Health check: `curl -H 'x-correlation-id: boot' localhost:3000/api/compliance/health` must return `{ status: "ok", ..., dncVendorReachable: true, litigatorVendorReachable: true }`.
8. Smoke: `curl -X POST localhost:3000/api/compliance/callable-now -H 'x-correlation-id: boot' -H 'content-type: application/json' -d '{"contactPhoneIds":["cp_nyc_confirmed_01"]}'` returns a well-formed `{ results: [...] }` payload with BOTH `contactPhoneId` and `phone` fields per result.

**Seed fixture — exact IDs the smoke test targets** (implemented by `scripts/seed-compliance-fixtures.ts`, mirrored in `contracts/mocks/compliance/fixtures/contacts.json`):

- Organization: `org_test` (slug `dealflow-ryan-test`).
- Contacts + ContactPhones:
  - `contact_nyc_01` (tz `America/New_York`), Lead address state `NY` → ContactPhone `cp_nyc_confirmed_01` (`+12125550001`). CallingWindowConfig for `America/New_York` is CONFIRMED.
  - `contact_nyc_02` (tz `America/New_York`), Lead address state `NY` → ContactPhone `cp_nyc_unconfirmed_02` (`+12125550002`). CallingWindowConfig unconfirmed for this test's org variant OR contact is under a second `org_test_unconfirmed`.
  - `contact_chi_01` (tz `America/Chicago`), Lead address state `IL` → `cp_chi_01` (`+13125550001`).
  - `contact_phx_01` (tz `America/Phoenix`), Lead address state `AZ` → `cp_phx_01` (`+16025550001`). No-DST test.
  - `contact_la_01` (tz `America/Los_Angeles`), Lead address state `CA` → `cp_la_01` (`+13105550001`).
  - `contact_notz_01` (tz `NULL`) → `cp_notz_01` (`+15555550999`). Fail-closed `timezone_unresolved`.
  - `contact_internal_dnc_01` (tz `America/New_York`) → `cp_internal_dnc_01` (`+15555550101`). Pre-seeded internal DncSuppression row.
- HolidaySuppressionDate: seed current-year + next-year federal + NY, CA, MA, IL, AZ.
- MobileLineCache: seed `+12125550001` as `mobile` with fresh `expiresAt`.
- ImportBatch: seed `ib_test_01` with a companion Lead whose `source = "import:ib_test_01"` to exercise bulk-scrub enumeration.

Gate 1 smoke curl uses `cp_nyc_confirmed_01` and expects `callable: true` (assuming call is within window and non-holiday, which the seed script asserts by picking a controlled `atInstant`).

Zero references to `../telephony`, `../comms`, `../core-data` runtime code. Only `@prisma/client` (including SELECTs against Contact/ContactPhone/Lead/ImportBatch which are populated by seed script), `contracts/mocks/**`, `contracts/events/**`, `contracts/http/**`, and slice-owned code.

### Gate 2 — Honors the contract (BOTH DIRECTIONS)

Contract test suite in `contracts/tests/compliance/**` runs in both directions:

**Direction 1 — slice EMITS + ACCEPTS frozen shapes:**
- `scrub.contract.spec.ts` — POST /api/compliance/scrub response validates against `contracts/http/compliance-scrub.schema.ts`. Every `reasons[]` value is drawn from `REASON_CODES` (§7A). Test iterates over every code and asserts at least one scenario produces it. **Field names are camelCase (`callable`, `contactPhoneId`, `phone`, `scrubbedAt`, `phoneCount`, `blockedCount`, `checkedAt`, `correlationId`, `reasonDetails`, `added`) — never snake_case.**
- `callable-now.contract.spec.ts` — same for /api/compliance/callable-now. Explicitly asserts BOTH `contactPhoneId` AND `phone` present in every result object.
- `callable-now.batch-cap.spec.ts` — POST with 101 `contactPhoneIds` returns HTTP 413 with body `{ error: "batch_too_large", maxItems: 100, receivedItems: 101 }`.
- `dnc-internal.contract.spec.ts` — POST /api/compliance/dnc/internal returns `{ id, phone, source: "internal", addedAt, added: boolean }` and `added=false` on second call for same phone.
- `policy.contract.spec.ts` — /api/compliance/policy/{confirm,status} shape.
- `circuit-resume.contract.spec.ts` — POST /api/compliance/circuit/resume shape + bearer auth.
- `event-scrub-completed.spec.ts` — captures the NOTIFY payload from `crm_scrub` and validates against Zod. Asserts NO `eventName` / `type` discriminant field in payload. Verifies emission happens inside the same DB tx as ScrubLog writes (test: transaction rollback → no NOTIFY visible to LISTEN).

**Direction 2 — MOCKS the slice consumes are faithful:**
- `mocks-faithful.spec.ts` — `mockDnc` / `mockLitigator` / `mockTwilioLookup` implement the respective vendor client interfaces. Fixture Contact/ContactPhone/Lead/ImportBatch rows in `contracts/mocks/compliance/fixtures/` conform to SHARED_CONTEXT §3 shapes so Agent A's real writes are drop-in when integration comes. Fixture Lead rows use `source = "import:" + importBatchId` per the planner-locked convention.

Both directions green.

### Gate 3 — Does its job

Behavioral acceptance tests + coverage floor **95% on the critical paths**. Below that, CI fails.

**Critical paths (coverage floor 95% branches AND lines):**
- `src/lib/compliance/timezone/**`
- `src/lib/compliance/holidays/**`
- `src/lib/compliance/policy/**`
- `src/lib/compliance/scrub/**`
- `src/lib/compliance/dnc/check.ts`, `dnc/internal.ts`
- `src/lib/compliance/litigator/check.ts`
- `src/lib/compliance/bulk/circuitBreaker.ts`
- `src/lib/compliance/bulk/checkpoint.ts`

**Mandatory behavioral tests (Gate 3):**

1. **Every fail-closed path → `callable: false`** (iterated over every REASON_CODE that maps to a failure mode).
2. **Timezone DST edge cases** per §9 1b frozen expectations.
3. **Holiday suppression** — MLK, Memorial, July 4, Labor, Thanksgiving, Christmas federal; Patriots' Day MA-only; Cesar Chavez CA-only; combined federal+state deduplicated.
4. **Bulk scrub perf at 25k contacts** — < 30 min against mock vendors.
5. **Bulk scrub resumable** — kill worker mid-batch, restart, verifies resumption from `BulkScrubCheckpoint.lastProcessedContactPhoneId`, no double-scrubbing.
6. **Internal DNC survives simulated re-imports** — §9 M2c. Also asserts `added: false` on re-post.
7. **Policy-confirmation gate** — unconfigured tenant returns `callable:false` for every phone.
8. **`scrub.completed` event emission** — Zod-valid, correlationId propagates, transaction rollback suppresses NOTIFY, no discriminant field in payload.
9. **`callable-now` p95 latency** — < 150ms warm-cache (M1), < 400ms warm-cache (M2 with vendor).
10. **Mobile-line is advisory only** — vendor error does NOT flip `callable` to false, only writes ScrubLog error row.
11. **Circuit-breaker resume** — open circuit → all vendor calls fail → POST `/api/compliance/circuit/resume` → next call attempts live vendor.
12. **Batch cap enforcement** — 101-item POST to `/api/compliance/callable-now` returns HTTP 413.
13. **Response shape** — every `callable-now` result contains both `contactPhoneId` and `phone`, even in fail-closed cases.

**CI enforcement:** each slice is its own Vitest project + coverage report. CI job `agent-c` runs Gates 1/2/3. Coverage below 95% on any critical-path file → red.

---

## 11. Failure-mode behavior

Exhaustive per-external-dependency table. This is the operational contract Agent B relies on. All reason strings are from `REASON_CODES` (§7A).

| Dependency | Failure mode | Behavior | ScrubLog | callable-now result |
|---|---|---|---|---|
| DNC vendor | Timeout > 10s | Fail-closed | operation `check-federal`/`check-state`, result `error`, detail `{ vendor, error, correlationId }` | `callable: false, reasons: ["vendor_error_dnc"]` |
| DNC vendor | 5xx / malformed JSON / any non-2xx | Fail-closed | Same | Same |
| DNC vendor | 429 rate-limit | Retry w/ exp backoff (max 3); still failing → fail-closed | Retry attempts logged; final logged as error | `callable: false, reasons: ["vendor_error_dnc"]` |
| Litigator vendor | Any error | Fail-closed | operation `check-litigator`, result `error` | `callable: false, reasons: ["vendor_error_litigator"]` |
| Twilio Lookup | Cache miss + live error | **Advisory only — does NOT flip callable** | operation `check-mobile-line`, result `error` | Reason NOT appended; call proceeds if other gates pass |
| Twilio Lookup | Stale cache + live error | Serve cached with `stale: true` | operation `check-mobile-line`, result `clean` w/ detail `{ stale: true }` | Advisory only |
| Node IANA tz db | Zone missing | Fail-closed | operation `check-window`, result `error`, detail `{ tz, error: "invalid IANA" }` | `callable: false, reasons: ["timezone_invalid"]` |
| Contact.timezone | Null / empty | Fail-closed | operation `check-window`, result `error`, detail `{ contactId }` | `callable: false, reasons: ["timezone_unresolved"]` |
| ContactPhone | Row missing | Fail-closed | operation `check-window`, result `error`, detail `{ contactPhoneId }` | `callable: false, reasons: ["phone_missing"], phone: ""` |
| CallingWindowConfig | Missing | Fail-closed | operation `check-window`, result `error`, detail `{ reason: "policy_unconfirmed", tz }` | `callable: false, reasons: ["policy_unconfirmed"]` |
| CallingWindowConfig | Present, unconfirmed | Fail-closed | Same | Same |
| HolidaySuppressionDate | >40d stale | Fail-closed | operation `check-holiday`, result `error`, detail `{ reason: "holiday_table_stale" }` | `callable: false, reasons: ["holiday_table_stale"]` |
| Batch cap | > 100 contactPhoneIds | Reject | Not logged (pre-pipeline) | HTTP 413 `{ error: "batch_too_large", maxItems: 100, receivedItems: <n> }` |
| Postgres | DB down | 500 to caller; Agent B's inline call treats as fail-closed | Log to pino/Sentry; no ScrubLog possible | (500) |
| pg-boss (bulk worker) | Queue down | Bulk worker dies; health endpoint surfaces | — | — |
| Vendor circuit-breaker | > 20% error rate over 5 min | HALT all vendor calls of that type; every subsequent request fails-closed until manual `POST /api/compliance/circuit/resume` (bearer `CRON_SECRET`) | operation `check-federal` or `check-litigator`, result `error`, detail `{ circuit: "OPEN" }` | `callable: false, reasons: ["circuit_open_dnc"]` or `["circuit_open_litigator"]` |

**Never do the following.** Any of these silently breaks TCPA compliance:
- Retry vendor errors indefinitely.
- Treat any non-2xx from a vendor as clean (pre-vendor-selection).
- Substitute cached DNC result older than the 24h read-through window.
- Continue scrub batches after circuit-breaker opens.
- Fall back to `NYC_TIMEZONE_DEFAULT` for a real contact.
- Skip ScrubLog write on fail-closed paths — the log IS the audit trail for TCPA.

---

## 12. Contract change protocol

Copied verbatim from SHARED_CONTEXT §12:

If an executor discovers a frozen contract is wrong: **STOP. Do not work around locally. Message the planner (Ryan).** Planner updates `dealflow-crm/CONTRACTS.md` + contract-test schemas + notifies all agents to re-pull. Never silently patch a mismatch — that's how 4-agent parallelism collapses.

For your slice, specifically:
- Do not add new `REASON_CODES` without planner sign-off.
- Do not rename `scrub.completed` payload fields. camelCase; `phoneCount`, `blockedCount`, `checkedAt`, `correlationId` — verbatim. NO `eventName` / `type` discriminant field (aligned with cross-slice convention).
- Do not add new events on any channel without planner sign-off.
- Do not add new HTTP endpoints under `/api/compliance/**` without planner sign-off.
- Prisma schema changes must be additive-only.

**Pre-authorized changes for THIS brief only (Ryan to ratify in CONTRACTS.md before executor session begins):**
1. `ScrubLog.operation` vocabulary extension: adds `check-holiday`, `check-mobile-line`.
2. New table `BulkScrubCheckpoint` (Agent C-owned).
3. New endpoint `POST /api/compliance/circuit/resume`.
4. Reason vocabulary `REASON_CODES` (§7A) as the frozen list — published centrally and referenced by Agents A and B in their consumed-mock schemas.
5. **Convention: `Lead.source = "import:" + importBatchId`** as an Agent A commitment for programmatic bulk-scrub joins. Supersedes the older `"mojo-import-<date>"` example in SHARED_CONTEXT §3 for the import-linkage use case. Ryan must coordinate this with Agent A's brief before Agent C's Milestone 2g.
6. **`POST /api/compliance/callable-now` batch cap of 100 contactPhoneIds**, published in `contracts/http/compliance-callable-now.json` with `maxItems: 100`. Requests exceeding return HTTP 413.
7. **`POST /api/compliance/callable-now` per-result shape** contains BOTH `contactPhoneId` AND `phone` fields (plus `callable`, `reasons`, optional `reasonDetails`). Locked to reconcile Agents A/B/C variants.
8. **`POST /api/compliance/dnc/internal` response shape** returns `{ id, phone, source, addedAt, added: boolean }` — the `added` field distinguishes new inserts (`true`) from idempotent no-ops (`false`) for Agent D's SMS-STOP telemetry.
9. **Discriminant-free event payloads.** `scrub.completed` (and all Agent C events) carry NO `eventName` / `type` field. Channel-as-routing convention applies across all four slices — planner harmonizes A and B briefs to match.

If any of the above isn't in CONTRACTS.md at session start, **STOP** and message planner.

---

## 13. Ryan's preferences

- **Always type deliverables in chat as full copyable text.** When you finish a milestone, dump acceptance criteria + smoke steps in chat, not just as a file.
- **`import 'dotenv/config'` MUST be the first import** of any script that touches DB. Even under Doppler.
- **Run `npx prisma generate` between `migrate dev` and `tsc`.**
- **iCloud landmine.** Sweep before every session (see §8).
- **Prisma sequential `.create()` is ~90ms/row over Railway.** Bulk writes >100 rows use `createMany({ skipDuplicates: true })` or a background job. Applies to your bulk-scrub ScrubLog writes.
- **Ship-when-tested.** If Gates 1/2/3 pass, hand off.
- **Minimum-viable-fix.** No multi-phase risk registers.
- **Prefer stronger model.** If you extend to LLM calls, use Claude Sonnet 4.6.
- **Do not rely on Outlook auto-refresh.** Not relevant to your slice.

---

## 14. Handoff / integration prep

When Gates 1/2/3 are green:

1. **README under `src/lib/compliance/README.md`** covering:
   - Public surface (endpoints, events).
   - How to boot in isolation.
   - Full fail-closed matrix (copy from §11).
   - How to configure a new CallingWindowConfig.
   - How to add a new state to holiday tracking.
   - How to switch DNC vendors (Doppler env change + which client file).
   - Where Ryan enters counsel-approved policy confirmation.
   - **Explicit note on `tzStateMap` broadness.** List every IANA → state[] bucket. Flag that `America/New_York`'s bucket includes Central-time-partial states (KY, IN) as intentional over-blocking for holiday-scope resolution only (never window-check). Ryan reviews and prunes before ship.
   - Note that stateFromTimezone over-blocks (fail-closed) rather than under-blocks when address state is missing.
   - Note that nightly full re-scrub of 25k phones costs vendor $; include projected monthly cost.
   - **Note on cross-slice timezone semantics:** Agents A and D may apply a display-layer fallback of `America/New_York` for null-tz contacts, but that fallback does NOT enter compliance — `callable-now` reads `Contact.timezone` directly and fails-closed on null. Result: leads returned by `/api/queue` with a fallback tz will still be blocked by C with `timezone_unresolved` on inline check. This is intentional fail-closed behavior.
   - **Note on batch cap:** `callable-now` accepts max 100 contactPhoneIds. Agent B must chunk larger dial queues client-side.

2. **Migration ordering doc.** Ensure your migration files timestamp-prefix cleanly and don't touch other agents' tables.

3. **CI job green.** `.github/workflows/agent-c.yml` runs `pnpm install`, `pnpm exec prisma migrate deploy`, `pnpm exec prisma generate`, `pnpm exec tsc --noEmit`, `pnpm exec vitest run --coverage`, asserts coverage on critical-path files ≥ 95%.

4. **Rebase clean onto `main`.** No merge conflicts on schema.prisma.

5. **Integration-day checklist to deliver to Ryan:**
   - `DNC_VENDOR` picked and API key in Doppler.
   - `LITIGATOR_VENDOR` picked and API key in Doppler.
   - `CallingWindowConfig` confirmed for `America/New_York` (Ryan + counsel).
   - `HolidaySuppressionDate` populated (cron ran at least once).
   - `MobileLineCache` warmed for initial 25k or acknowledged first-day lookup cost.
   - `CRON_SECRET` documented for `/api/compliance/circuit/resume`.
   - Agent B's inline `callable-now` call verified end-to-end against a live NYC contact, with response shape including both `contactPhoneId` and `phone`.
   - Agent A's queue endpoint returns `primaryPhoneE164` field (planner-locked rename); C's fixtures and contract tests are already aligned to this name via the shared REASON_CODES publication.
   - Agent D's SMS STOP handler calls `POST /api/compliance/dnc/internal` and consumes the `added` field.
   - Sentry alerts wired: `holidayTableFreshDays > 7` warning; `> 40` error.
   - `BulkScrubCheckpoint` clean (no orphaned `halted` rows).
   - Agent A's importer commits to `Lead.source = "import:" + importBatchId` (verify one live import round-trip).

6. **Known-open items to flag on handoff:**
   - Mobile-line advisory: currently logged, not enforced. Note stricter mobile-only rules can be layered in via a future CallingWindowConfig extension.
   - `stateFromTimezone` tz-bucket fallback over-blocks (fail-closed) when address state missing.
   - Nightly full re-scrub vendor $.
   - Real-data 34% phone-missing rate: bulk worker filters at query time; phones that never enter the pipeline don't produce `phone_missing` reasons.
   - `Lead.source` convention (`"import:" + importBatchId`) is an Agent A commitment; if A ships a different convention, bulk worker enumeration breaks — verify before go-live.
   - Cross-slice timezone-fallback asymmetry: A/D fall back to NYC at display, C fail-closes. Leads with null tz appear in queue but are blocked at dial. Ryan should be told the ammunition panel may briefly show these before the call is blocked.

**Definition of done:**
- All three gates pass in CI.
- 95% coverage floor holds on critical-path files.
- README delivered.
- Handoff checklist typed to Ryan in chat.
- All vendor client files exist; only chosen vendors need exercised tests; unchosen vendors have unit-level shape tests + documented "vendor not configured → fail-closed" pathway.

You are the legal fail-safe. If in doubt, block the call and log the reason. That is always the right answer.