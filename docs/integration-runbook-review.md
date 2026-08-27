# Integration Runbook — Agent A review

Reviewed `docs/integration-runbook.md` (v1, ratified 2026-08-27) against Agent A's
actual slice code. Verdict: **structurally sound — merge order and rollback claims
are correct and I verified them against the real FK graph.** 4 material items to fold
in, 2 minor. Evidence cited by file:line so you can confirm without re-deriving.

---

## Material (fold before integration)

### M1 — §13 table is missing A's `NotifyOverflow` table
The amendments table (13 rows) catalogues D/B/C schema additions but omits an
**A-owned** one: `NotifyOverflow` (`prisma/schema.prisma:358`), added via the second
migration `20260827052053_add_notify_overflow`. It's additive, A-owned, and NOT in the
base scaffold's consolidated schema — so PR #1's diff will legitimately include a table
+ migration a reviewer expecting "core-data only" might flag as unexpected. **Add a row:**
`| 14 | NotifyOverflow new table (NOTIFY payload-overflow spillover) | A | additive | Yes |`
and note in PR #1 post-merge verify that `prisma migrate status` should show **two**
A migrations (`initial` + `add_notify_overflow`), not one.

### M2 — reason-codes superset invariant is unstated, and it's a hard PR #2 gate
Amendment #9 rewrites `contracts/http/reason-codes.ts` 12 → 19 codes. Two exposures the
runbook's "take C's version (granular §7A wins)" note doesn't cover:
- A's `src/lib/shared/reason-codes.ts:16` **throws at module load** if `timezone_unresolved`
  is absent from the enum. If C's 19-code set drops it, A's app *and* `boot:all` fail to
  boot — not a test failure, a hard crash on import.
- A and B both import these literals; `reasonCodeSchema = z.enum(REASON_CODES)`. Any
  *removal* (not just of `timezone_unresolved`) breaks every consumer referencing the
  dropped literal.

**Gate to add (PR #2 pre-merge):** C's 19 codes MUST be a strict **superset** of the
current 12 — none removed. The current frozen 12 that must survive:
`internal_dnc, federal_dnc, state_dnc, litigator, outside_calling_window_hour,
outside_calling_window_day, holiday_federal, holiday_state, policy_unconfirmed,
timezone_unresolved, vendor_error, window_stale`.
Concretely: `git show agent-c:contracts/http/reason-codes.ts` and diff against main —
confirm additions-only before merging. Change the rebase note from "take C's version" to
"take C's version **after** confirming it's a superset, not a replacement."

### M3 — `db push` ↔ migration collision: `migrate status` alone won't catch it (PR #4)
D applied `OAuthCredential` to the shared `dealflow_crm` DB via `prisma db push`, which
writes **no migration-history row**. When PR #4 brings `OAuthCredential` as a real
migration, `prisma migrate deploy` against the shared DB will try to `CREATE` columns that
already physically exist → apply fails; and `migrate status` reports drift rather than
resolving it. The runbook leans on `migrate status` as the between-merge invariant (lines
56, 134) — necessary, but **not sufficient** for the db-push case.

**Fix before PR #4:** D must reconcile the db-push columns into migration ownership — either
(a) baseline: `prisma migrate resolve --applied <oauthcred_migration>` so Prisma records it
applied without re-running DDL, or (b) drop the db-pushed columns first and let the migration
own the `CREATE`. Also, because all four slices share ONE remote DB and migrations apply
cumulatively as each PR merges, add a per-PR invariant: **`prisma migrate deploy` exits 0**
(actually applies) — not just `migrate status`. Status is read-only; deploy is the real gate.
(This is my handoff's open D↔A item; the runbook's collision-check line assumes it's closed.)

### M4 — `/api/queue` field rename `primaryPhone` → `primaryPhoneE164` (PR #3 care)
A's queue response returns `primaryPhoneE164` (`queue-service.ts:87,220`), renamed from the
brief's `primaryPhone`. B consumes `GET /api/queue` (real, not mock) for the ammunition panel
at PR #3. If B's mock/consumer reads `primaryPhone`, it breaks post-merge. Add a PR #3
rebase-care bullet: **confirm B reads `primaryPhoneE164`** (E.164-normalized string, not
`primaryPhone`). Belongs in the §13 table too as an A-owned HTTP-shape amendment.

---

## Minor (fix, don't belabor)

### m5 — Acceptance smoke hits the wrong cron path
Line 136: `POST /api/cron/dealflow-sync` — the real route is
**`/api/cron/dealflow-signal-sync`** (`src/app/api/cron/dealflow-signal-sync/route.ts`).
As written the smoke 404s. Also note it requires the `CRON_SECRET` bearer header (same as the
circuit-breaker resume on line 140).

### m6 — Two A-headline features have no composed smoke
The 9 acceptance smokes cover import/sync/compliance/dial/OAuth/sequences but skip A's two
centerpieces. Recommend adding:
- **Advanced Filtering DSL / Smart View** — `POST /api/data/search` with a nested `s_query`
  (e.g. `has_related` + a date predicate) → returns correctly filtered leads. This is the
  25k-perf feature; nothing else exercises the compiler end-to-end in the composed run.
- **`/api/queue` payload** — after import + sync, `GET /api/queue` returns rank + ammunition +
  `primaryPhoneE164`. This is the integration payoff (it's in my handoff checklist) and ties
  M4 above to a live assertion.
- (Optional) **custom fields** — define → set value on a Lead → filter by it. Lower priority.

---

## Affirmed — checked, correct, no change needed

- **Merge order A → C → B → D is correct.** Verified every edge: A has no deps; C depends on A
  (`Lead.source = "import:"+batchId` convention + shared reason-codes); B depends on A
  (`/api/queue`, `Lead`/`Contact`/`DealFlowDerivedSignal`) **and** C (`callable-now`); D depends on
  A (`Contact` resolution, `crm_message`) **and** C (`dnc/internal`, dead until SMS on). Order honors
  all edges; no cycle.
- **Rollback claims are FK-accurate** — I checked the actual `@relation` graph, not just "shared
  types":
  - **A revert = catastrophic ✓** — B's `Call.userId`, C's configs, and D's `Message`/`OAuthCredential`
    all FK into A-owned `User`/`Organization` (`schema.prisma:422,565,617`). Drop those and every
    slice's inserts fail. Correct, and now with a concrete reason.
  - **B revert = safe ✓** — no A/C/D model FKs into `Call`/`CallLeg`/`DialSession`. Crucially, A's
    `Activity` has **no `callId` FK** — `call.completed` is projected into `Activity` *by value*, with
    `onDelete: SetNull` only to `Lead`/`Contact`/`User` (`schema.prisma:228-230`). Nuance: `Call` sits in
    the base scaffold, so reverting B's squash removes B's routes/worker but likely not the table —
    even safer than "drops Call."
  - **C revert = risky ✓** — B's `callable-now` check 404s (runtime dep, no FK). Correct.
  - **D revert = safe ✓** — A's `Activity` has no `messageId` FK; `message.received` is likewise
    projected by value. Correct.
  The by-value + `SetNull` projection is *why* B/D reverts are safe — worth one annotation in the
  runbook so a future reader doesn't assume an FK exists and over-worry.
- **Prisma additive/nullable rollback semantics** (line 127) — matches what I saw; A's client tolerates
  unknown columns.

---

## One-line summary for the planner
Runbook is green to drive integration. Fold M1–M4 (NotifyOverflow row, reason-codes superset gate,
`migrate deploy` + db-push reconciliation for D, `primaryPhoneE164` for B); patch the cron path and
add the DSL/queue smokes. Merge order and rollback safety are confirmed against the real FK graph — no
changes there.
