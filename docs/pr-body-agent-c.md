## Summary

Agent C — **Compliance slice** (the legal fail-safe): fail-closed core (DST-aware
calling-window evaluator + holiday suppression + policy-confirmation gate +
timezone resolver + internal DNC) + M2 vendor scaffold (TCPA Shield federal/state
DNC + litigator + Twilio Lookup mobile-line, **PROVISIONAL wire shape**) +
`scrubPhones` bulk pipeline + resumable 25k bulk-scrub worker + nightly
`dnc-refresh`/`holiday-refresh` crons. **219 tests**; per-file **95% branches +
95% lines** enforced on the critical paths; Gate 2 (contract, both directions) +
Gate 3 (behavioral) automated green. `tsc --noEmit` clean.

First rule of the slice: **fail-closed**. Any error, timeout, missing config,
unconfirmed policy, ambiguous timezone, or unreachable vendor → `callable:false`.
Never a positive signal from a negative check.

## Contract exposures (this slice)

- **Emits** (channel `crm_scrub`): `scrub.completed`
  `{ phoneCount, blockedCount, checkedAt, correlationId }`. Emitted inside the
  same DB tx as the ScrubLog writes. **No `eventName`/`type` discriminant** —
  channel-as-routing.
- **Consumes**: none (pure producer + on-demand query surface). Runtime
  cross-slice data access is **Prisma SELECT** on A's `Contact` / `ContactPhone`
  / `Lead` / `ImportBatch` / `Organization` — never HTTP.
- **HTTP** (8 under `/api/compliance` incl. health, + 2 crons):
  - `POST /api/compliance/callable-now` — hot path (inline before every dial).
    **100-id batch cap → HTTP 413** `{error:"batch_too_large",maxItems:100,receivedItems}`.
    Per-result carries BOTH `contactPhoneId` AND `phone`, plus `callable`,
    `reasons[]`, optional `reasonDetails`.
  - `POST /api/compliance/scrub` — bulk suppression scrub →
    `{ results:[{phone,callable,reasons,reasonDetails?}], scrubbedAt }`.
  - `GET  /api/compliance/dnc/suppressions?phone=E164`
  - `POST /api/compliance/dnc/internal` → `{ id, phone, source:"internal", addedAt, added:boolean }`
  - `POST /api/compliance/policy/confirm`  ·  `GET /api/compliance/policy/status`
  - `POST /api/compliance/circuit/resume` — bearer `CRON_SECRET`
  - `GET  /api/compliance/health`
  - `GET  /api/cron/dnc-refresh` — bearer `CRON_SECRET`, 503 when no vendor
  - `GET  /api/cron/holiday-refresh` — bearer `CRON_SECRET`
  - (Consumed by B via `COMPLIANCE_BASE_URL`; B must treat a 5xx as `callable:false`.)
- **Owns**: `contracts/http/reason-codes.ts` — the **granular §7A 19-code
  `REASON_CODES`** list (ratified 2026-08-27). Single source of truth; A imports
  it verbatim, B imports + tolerates unknowns.

## §13 amendments in this slice

- **`BulkScrubCheckpoint`** — reshaped the C-owned scaffold table to brief §5:
  renamed `lastProcessedPhone`→`lastProcessedContactPhoneId`; added `chunkIndex`,
  `haltReason`; `@@index([orgId,importBatchId])`→`@@unique([orgId,importBatchId])`
  + `@@index([orgId,status])`; `importBatchId` now non-null; dropped `startedAt`.
  **NOT purely additive** (rename + constraint change) but safe — zero cross-agent
  readers, no prod data.
- **`ScrubLog.operation` vocabulary** — extended with `check-holiday`,
  `check-mobile-line`. Additive (String column; vocabulary only).
- **`REASON_CODES` 12 → 19 (granular §7A)** — expansion + `window_stale` →
  `holiday_table_stale` rename + `vendor_error` split into
  `vendor_error_dnc|_litigator|_mobile_line|_not_configured` + added
  `timezone_invalid`, `circuit_open_dnc|_litigator`, `phone_missing`. Breaking
  **only** for a `window_stale` consumer — there are none (A verbatim-imports; B
  tolerant).
- **`dnc/internal` response** — added `added:boolean` (Agent D SMS-STOP telemetry).
- **Contract locks (C-exposed, §12 #6/#7/#9)**: callable-now 100-batch cap → 413;
  per-result both `contactPhoneId` + `phone`; `scrub.completed` discriminant-free.

> NOTE — the **Brief §9 1b DST frozen value** (`localHour===3` for
> `2027-03-14T06:30Z`) is arithmetically wrong (the 2027 spring-forward
> transition is 07:00Z, so that instant is 01:30 EST → hour **1**). This is a
> **brief-text correction, not a schema/contract amendment** — my test asserts
> the real ICU output (1). Track it as a brief fix, not in the §13 schema table.

## Cross-slice notes

See `src/lib/compliance/README.md` — full fail-closed matrix, how to configure a
`CallingWindowConfig`, the vendor swap-in procedure for TCPA Shield, the
`tzStateMap` NY-bucket over-block explanation (NY intentionally covers KY/IN/MI/TN
for holiday-scope resolution only, never the window check), and the cross-slice
timezone semantics (A/D may display-fallback null tz to `America/New_York`, but C
reads `Contact.timezone` directly and fails-closed on null — leads appear in the
queue but block at dial; intentional).

## Test coverage

219 tests (unit + contract + behavioral + perf). Per-file floor **95% branches
AND 95% lines** on critical paths, enforced via `vitest.agent-c.config.ts` +
`.github/workflows/agent-c.yml`: timezone 97.4%, holidays 97.4%,
policy/scrub/dnc-internal/dnc-check/litigator-check/circuitBreaker/checkpoint
100% (2 genuinely-unreachable defensive guards `v8 ignore`d with rationale).
Automated gates need NO live DB (decision logic tested with injected fakes);
Gate 1 live-boot is Doppler-optional (`bash scripts/run-isolation-boot.sh`).

## Notes for the merge

- **One migration owed at integration.** A's `initial` migration already creates
  all 7 compliance tables (verified on `origin/agent-a`), so C owes only a
  `BulkScrubCheckpoint` **reshape** ALTER (rename `lastProcessedPhone`→
  `lastProcessedContactPhoneId`, add `chunkIndex`/`haltReason`, drop `startedAt`,
  `importBatchId` NOT NULL, index→unique + add status index). Generate
  post-rebase (`migrate dev --name compliance-bulkcheckpoint-reshape`), timestamp
  AFTER A's migrations. Safe — no prod data in the table.
- **Vendor wire PROVISIONAL** (TCPA Shield). When `DNC_API_KEY`/`LITIGATOR_API_KEY`
  land, vendor tests re-run against real docs — confirm-and-adjust, not rebuild.
  With no key, callable-now fail-closes (`vendor_error_not_configured`) — correct.
- C reads A's `Contact.timezone`, `ContactPhone.phone/id/contactId`,
  `Lead.addresses/primaryAddressFull/source`, `ImportBatch`, `Organization` —
  verify these column names against A's final schema at merge.
- Adopt A's shared-Railway-DB test posture (`isolate:false`, `maxWorkers:1`,
  `pool:'forks'`, `?connection_limit=20`) for any live-DB integration smoke.

## Ready to merge

Rebased on merged `main` (post-A). **Second in dependency order (A → C → B → D).**
Reads A's `Lead.source = "import:" + importBatchId` convention for bulk-scrub
enumeration. Additive/reshape schema conflicts resolved before opening. No PR
until all four slices are Gate-3 green.
