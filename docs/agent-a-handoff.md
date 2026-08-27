# Agent A — Core Data slice: Integration Handoff

Slice: **Core Data & Smart Views + AI Importer + Custom Fields.** Built in isolation against mocks of B/C/D. All three acceptance gates green.

## Boot

```bash
pnpm install
pnpm prisma migrate deploy         # or `migrate dev` for a fresh DB
pnpm run boot-standalone           # mock compliance :5555 + listeners + Next :3000 → prints SLICE READY
curl localhost:3000/api/core-data/health   # → { status: "ok", ... }
```

## Test commands

| Command | What it runs |
|---|---|
| `pnpm test` | Full suite (146 tests: unit + contract + integration + perf) |
| `pnpm run test:contract` | Gate 2 — contract tests, both directions |
| `pnpm run test:coverage` | Gate 3 — behavioral + 85% floor on critical paths |
| `pnpm run test:perf` | 25k-row Smart-View p95 assertion |
| `pnpm run seed:perf` / `pnpm run perf` | Seed the perf DB + run the perf harness standalone |

**Test-infra note:** every integration suite hits ONE remote Railway DB. `vitest.config.ts` runs the whole suite in a single process sharing one Prisma pool (`isolate:false`, `maxWorkers:1`, `pool:'forks'`) — do NOT re-enable file parallelism or the shared DB thrashes (connection pile-up → 30s pool-timeout stalls). `DATABASE_URL_MAIN` carries `?connection_limit=20`.

## Runtime env vars (see `.env.example`)

`DATABASE_URL_MAIN`, `DATABASE_URL_DEALFLOW_RO`, `DATABASE_URL_PERF`, `CRON_SECRET`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (locked `claude-sonnet-4-6`), `R2_*`, `COMPLIANCE_BASE_URL`, `COMPLIANCE_CALLABLE_BATCH_SIZE` (≤100), `DEALFLOW_SYNC_STUB`, `USE_PGBOSS`.

## Cross-brief lock-downs applied

- **No `eventName`/`type` on A's emissions.** `emit()` strips both discriminants before serializing; routing is `(channel, payload-shape)`. Verified in `contracts/tests/emits-events.spec.ts`.
- **`primaryPhoneE164`** in `/api/queue` response (renamed from `primaryPhone`). Verified in `contracts/tests/http-shapes.spec.ts`.
- **`cost` is decimal-as-string** on `call.completed`; the activity projector stores it verbatim, never `Number(cost)`. Verified in `tests/integration-local/events.test.ts`.
- **`Lead.source = "import:" + importBatchId`** on every importer upsert (C's bulk-scrub enumeration). Verified in `tests/integration-local/importer.test.ts`.
- **Compliance batch cap 100**, enforced by `resolveBatchSize()` (throws above 100) + the mock's 413.
- **Timezone split semantics:** display fallback `America/New_York`; compliance request omits tz when unknown → C fail-closes with `timezone_unresolved` → counted in `excludedCompliance`, `stale` stays false.
- **`REASON_CODES` sourced from `contracts/http/reason-codes.ts`**, re-exported via `src/lib/shared/reason-codes.ts` (asserts `timezone_unresolved` present at load).

## Known deviations / open planner items

1. **DealFlow RO schema differs from the brief's reference.** Verified against the live `railway` DB 2026-08-27: `CallQueueEntry(contactId, rank, reason, primaryMatchId)` — NOT `mojoContactId/queueRank/queueReason`; `Match.score` — NOT `matchFit`. The sync (`sync.ts`) is mapped to the ACTUAL columns. This is A-side (my owned `DealFlowDerivedSignal` table stays frozen); the DealFlow schema is a read reference, not a cross-agent contract.
2. **`REASON_CODES` naming:** the frozen enum uses `outside_calling_window_day`/`holiday_federal`/`holiday_state`/`vendor_error`/`window_stale` (vs the brief's illustrative `_dow`/`holiday_suppression`/`mobile_line_blocked`). A imports the frozen file verbatim and does not define its own — `timezone_unresolved` (the fallback A depends on) IS present.
3. **Two migrations, not one** (`initial` + `add_notify_overflow`). `NotifyOverflow` was an A-owned new table not present in the pre-scaffolded consolidated schema; added additively. Both are applied to MAIN + PERF. Squash optional before merge.
4. **R2 + pg_dump not available in the build env.** The importer storage layer falls back to local FS (`.imports/`) when R2 creds are absent; `backup.ts`/`restore-from-backup.ts` use a Prisma logical JSON export (production should use `pg_dump`/`pg_restore`). Swap at integration.
5. **Playwright E2E** (`tests/e2e/importer-happy-path.spec.ts`) is written but not run here (needs browser install + a real `ANTHROPIC_API_KEY` + boot-standalone). Run at integration.
6. **pg-boss** is opt-in via `USE_PGBOSS=1`; without it the importer commit runs detached-inline so the route still returns 202. Integration should enable pg-boss for retry semantics.

## ⚠️ Cross-slice notes (B / C / D — read before integration)

**1. DealFlow live-schema map (authoritative — supersedes the brief's reference block).**
Nobody but A should read DealFlow directly, but if that changes, use these ACTUAL columns (verified against the live `railway` DB 2026-08-27), not the brief's older draft names:

| DealFlow table | Actual columns A's sync reads | Brief's (wrong) reference |
|---|---|---|
| `CallQueueEntry` | `contactId`, `rank`, `priorityScore`, `reason`, `primaryMatchId`, `contributions`, `generatedAt` | ~~mojoContactId, queueRank, queueReason~~ |
| `MojoContact` | `id`, `mojoId`, `fullName`, `phone`, … (join `id = CallQueueEntry.contactId`, read `mojoId`) | (ok) |
| `Match` | `id`, `score`, `captureStatus`, `matchFitConfidence`, `reason` (join `id = CallQueueEntry.primaryMatchId`) | ~~matchFit~~ → use `score` |

A's owned `DealFlowDerivedSignal` shape is unchanged/frozen — this is a read-side mapping only.

**2. Test-infra posture (adopt if you run vitest against the shared Railway DB — Agent B especially, for the PERF-DB property test).**
All slices share ONE remote Railway Postgres. Parallel vitest files → connection pile-up → 30s `pool_timeout` stalls → ~50-minute runs. Use in `vitest.config.ts`:
`pool: 'forks'`, `isolate: false`, `maxWorkers: 1`, `minWorkers: 1`, `fileParallelism: false`; add `?connection_limit=20&pool_timeout=30` to the DB URL; and do NOT call `prisma.$disconnect()` in integration `afterAll` (the shared singleton persists across files). This took A's suite from 51 min → 145 s.

**3. Shared-DB collision check (D ↔ A):** verified clean 2026-08-27. `prisma migrate status` on `dealflow_crm` = "up to date"; A's 2 migrations intact; D's additive/nullable `OAuthCredential` `db push` did not alter any A-owned table. `OAuthCredential` + `NotifyOverflow` both present. A does not touch `OAuthCredential`.

## Integration checklist (from brief §14)

- Swap mock compliance for real Agent C (`COMPLIANCE_BASE_URL`).
- Wire real B `call.connected`/`call.completed` (confirm `cost` arrives as string).
- Wire real D `message.received`; confirm D consumes `lead.upserted-from-import`.
- Smoke: upload real Mojo CSV → every Lead `source = "import:<batchId>"` → run DealFlow sync → open `/api/queue` → confirm rank + ammunition + `primaryPhoneE164` → verify C's `REASON_CODES` on excluded phones.
