# Integration-runbook review — Agent C (compliance)

## 0. Blocker — runbook not reachable

`docs/integration-runbook.md` is **not present on any ref I can access**:
local `main` has no `docs/` tree at all; `origin` has no `main` branch (only
`agent-a|b|c|d`). It's likely uncommitted/unpushed on your local main. I could
not review the literal 13-row §13 table, merge-order prose, checklist, etc.

Below is my compliance input on your 5 questions from slice knowledge — fold in
when the runbook is reachable. **Material items only.**

## 1. §13 amendments — did you miss/mis-label any C-owned row?

Additions:
- **`BulkScrubCheckpoint` is a RESHAPE, not a clean-additive new table.** The
  scaffold already had a (drifted) version in the frozen base schema; I renamed
  `lastProcessedPhone`→`lastProcessedContactPhoneId`, added `chunkIndex`/
  `haltReason`, flipped `@@index`→`@@unique([orgId,importBatchId])` + added
  `@@index([orgId,status])`, made `importBatchId` non-null, dropped `startedAt`.
  If the table shows as "additive," relabel: **reshape (rename + constraint) of a
  C-owned table — safe because zero cross-agent readers + no prod data.**
- **`REASON_CODES` 12→19 carries a RENAME** (`window_stale`→`holiday_table_stale`)
  and a **split** (`vendor_error`→4 codes), not just additions. Breaking only for
  a `window_stale` consumer — none exist (A verbatim-imports, B tolerant; B's own
  `schema-drift-pending.md` already records the convergence). Safe, but label it
  "expansion + rename/split," not "pure add."
- **Mis-label risk: the Brief §9 1b DST correction is NOT a §13 schema/contract
  amendment.** It's a brief-text arithmetic fix (`localHour===3`→ real ICU `1`
  for `2027-03-14T06:30Z`). If it's sitting in the schema-drift table, move it to
  a "brief corrections" note. My test asserts the true value.
- Confirm these C-exposed **contract locks** are catalogued somewhere (amendments
  or exposures): callable-now 100-batch-cap→413; callable-now per-result carries
  both `contactPhoneId`+`phone`; `scrub.completed` is discriminant-free.

## 2. Merge order / A→C dependencies

- "C depends on A's `Lead.source = "import:" + importBatchId`" is **correct** (bulk
  worker enumeration).
- **The A→C dependency is BROADER than Lead.source.** C runtime-SELECTs A's
  `Contact.timezone`, `ContactPhone.{id,phone,contactId}`,
  `Lead.{addresses,primaryAddressFull,source,timezone}`, `ImportBatch`,
  `Organization`. Add to the runbook: **verify these exact column names against
  A's final schema at merge** (A's handoff flagged live-schema drift on
  `CallQueueEntry`/`Match` — those don't touch C, but confirm the Contact/Phone/
  Lead columns didn't drift too).
- Order A → C → B → D is right for C: A owns the canonical schema C reads; B's
  dial loop calls C's callable-now (so C before B).

## 3. Pre-integration checklist — additional strict needs

Beyond your list (CallingWindowConfig INSERT + tzStateMap prune + TCPA keys):
- **Migration — resolved (checked A's branch):** A's
  `20260827045415_initial/migration.sql` creates the **whole consolidated
  schema**, including all 7 compliance tables. So C does **NOT** owe a
  tables-creation migration. BUT A's initial `BulkScrubCheckpoint` is the **old
  scaffold shape** (`importBatchId` nullable, `lastProcessedPhone`, `startedAt`,
  no `chunkIndex`/`haltReason`, `@@index([orgId,importBatchId])`). C's schema
  reshaped it. So the **one migration C owes** (generate post-rebase on merged
  main): rename `lastProcessedPhone`→`lastProcessedContactPhoneId`, add
  `chunkIndex`/`haltReason`, drop `startedAt`, `importBatchId` SET NOT NULL, drop
  the plain index → add `@@unique([orgId,importBatchId])` + `@@index([orgId,status])`.
  Safe (no prod data in the table). `prisma migrate dev --name compliance-bulkcheckpoint-reshape`.
- **Adopt A's shared-Railway-DB test posture** (`isolate:false`, `maxWorkers:1`,
  `pool:'forks'`, `fileParallelism:false`, `?connection_limit=20&pool_timeout=30`,
  no `$disconnect()` in `afterAll`) for any C live-DB integration smoke. C's
  automated gates are DB-free (fakes) so they don't need it — the composed boot
  smokes do.
- **`COMPLIANCE_BASE_URL`** set to C's deployed URL (A shipped this name; B uses
  it in the M4 dial loop). **`CRON_SECRET`** shared value across slices (C uses it
  for both crons + circuit/resume).

## 4. Post-integration acceptance smokes (compliance-specific)

Beyond callable-now smoke + circuit-halt smoke, add (highest-value first — each
guards a core legal fail-safe guarantee whose regression = TCPA exposure):
- **Policy-gate fail-closed:** a contact in a timezone with no confirmed
  `CallingWindowConfig` → `policy_unconfirmed`. Catches an accidental
  "default-confirmed" regression. **#1 priority.**
- **Vendor-not-configured fail-closed:** with no DNC key, callable-now returns
  `vendor_error_not_configured` (block) — NOT callable. Catches a silent-pass
  regression on an unconfigured vendor.
- **Internal-DNC survives re-import:** add internal DNC for a phone → A re-imports
  that contact (new ContactPhone row) → re-check still `internal_dnc`. Catches the
  "survives re-import" guarantee (keyed on phone, not ContactPhone.id).
- **timezone_unresolved cross-slice:** a null-tz contact that A/D display-fallback
  to ET → callable-now still `timezone_unresolved` (proves the display fallback
  doesn't leak into compliance).
- **Holiday federal:** an `atInstant` on a seeded federal holiday → `holiday_federal`.
- **scrub.completed wiring:** a scrub emits on `crm_scrub` and A's projector logs
  it (cross-slice event path).

## 5. Rollback safety — correct the framing

Your claim "C revert = risky (B's callable-now would 404), prefer forward-fix" is
directionally right but **mis-frames the risk**:
- If C is reverted/down, B's inline callable-now call 5xx's — and **B is
  contractually required to treat that as `callable:false` (fail-closed)**. So a C
  outage **halts all dialing (fail-SAFE)**; it does NOT let illegal calls out.
  Reverting C is safe w.r.t. TCPA — it just makes the dialer unavailable.
- So: **prefer forward-fix for AVAILABILITY, not for legal safety** (the legal
  posture is safe either way). Recommend wording: "C revert → dialer halts
  (fail-safe, zero illegal calls); forward-fix preferred to restore dialing."
- Reverting C's *code* does not drop C's *tables* — `DncSuppression` (incl.
  internal opt-outs), `LitigatorSuppression`, `MobileLineCache`, holidays persist.
  Only a down-*migration* would touch schema; a `halted` `BulkScrubCheckpoint` is
  recoverable by re-enqueueing the bulk job. Note this so a revert isn't confused
  with data loss.
