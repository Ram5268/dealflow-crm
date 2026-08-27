# PR #2 rebase checklist — Agent C

Actions to perform when C rebases on merged `main` (post-A), BEFORE opening C's
PR. Do NOT do these now — they belong at rebase time. Captured here so they
survive the standby → next-session boundary.

## 1. Add `compliance_unavailable` — 20th REASON_CODE (planner §12, 2026-08-27)

**Why:** A's `compliance-bridge.ts` fails-closed when C is **entirely
unreachable / returns no verdict** — a service-level failure only A observes.
That is NOT one of C's four `vendor_error_*` codes (which name *which vendor*
failed) and NOT `vendor_error_not_configured` (vendor-level). The correct code
is `compliance_unavailable`. Without it, A silently emits a stale `vendor_error`
string on the C-outage path → wrong reason in the TCPA audit trail, missed by
contract tests (which run against healthy mock C). Worst-shape audit bug: silent,
low-probability, correctness violation.

**Action (wire-type widen only — ZERO change to C's fail-closed logic; C never
emits this, only A does):**
- `contracts/http/reason-codes.ts` → add `'compliance_unavailable'` as the 20th
  code (alongside the granular 19). Keep it clearly commented as A-emitted /
  service-level.
- `contracts/tests/schemas/barrel.spec.ts` → bump the length assertion **19 → 20**
  and add a `toContain('compliance_unavailable')`.
- `contracts/http/compliance-callable-now.json` → add `compliance_unavailable`
  to the `ReasonCode` enum (keeps the OpenAPI enum in sync with the TS list).
- C's own tests already assert reasons ∈ `REASON_CODES` via the schema — no
  behavior change needed; just make sure nothing asserts `length === 19`
  elsewhere (grep `REASON_CODES.length`).

**Do NOT** reuse `vendor_error_not_configured` (semantically wrong) or invent
`vendor_error_unreachable` (reads as a vendor error). `compliance_unavailable`
restores the service-level semantic and keeps the granular `vendor_error_*` split
clean.

## 2. `BulkScrubCheckpoint` reshape migration

A's `initial` migration already creates all 7 compliance tables, but with the OLD
scaffold `BulkScrubCheckpoint` shape. After rebasing on merged main, generate ONE
migration to bring the table to C's schema:

```
prisma migrate dev --name compliance-bulkcheckpoint-reshape
```

Expected diff: rename `lastProcessedPhone`→`lastProcessedContactPhoneId`; add
`chunkIndex`/`haltReason`; drop `startedAt`; `importBatchId` SET NOT NULL; drop
`@@index([orgId,importBatchId])` → add `@@unique([orgId,importBatchId])` +
`@@index([orgId,status])`. Safe — no prod data in the table. Timestamp must sort
AFTER A's `20260827*` migrations.

## 3. Post-rebase gate re-run

```
corepack pnpm@9 exec prisma generate
corepack pnpm@9 exec tsc --noEmit
corepack pnpm@9 exec vitest run --config vitest.agent-c.config.ts --coverage
```
All green + coverage floor holds → open C's PR with `docs/pr-body-agent-c.md`.
