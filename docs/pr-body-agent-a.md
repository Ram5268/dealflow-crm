## Summary

Agent A — **Core Data slice**: Advanced Filtering DSL + Smart Views + AI Importer + DealFlow signal sync + custom fields. 10 milestones green; Gate 1 (boot-standalone `SLICE READY` + `/health` ok), Gate 2 (contract tests both directions), Gate 3 (146 tests, per-file 85/85/80 floors on critical paths, 25k-row Smart-View p95 ≈ 95 ms).

## Contract exposures (this slice)

- **Emits** (channel `crm_lead_sync`): `lead.upserted-from-import`, `lead.derived-signals-synced`. No `eventName`/`type` discriminant on the wire — routing is `(channel, payload-shape)`.
- **Consumes**: `call.completed`, `scrub.completed`, `message.received`.
- **HTTP**: `GET /api/queue` (returns `primaryPhoneE164`), `POST /api/data/search` (DSL), importer flow (`POST /api/imports/*`), `GET /api/core-data/health`, `POST /api/cron/dealflow-signal-sync`.

## §13 amendments in this slice

- **#14 — `NotifyOverflow` new table** (A-owned). LISTEN/NOTIFY payload-overflow spillover; additive, shipped as a second migration `add_notify_overflow`. PR #1's diff includes two A migrations (`initial` + `add_notify_overflow`), not one.
- **#15 — `/api/queue` wire rename `primaryPhone` → `primaryPhoneE164`** (A-owned). E.164-normalized string. B consumes `GET /api/queue` at PR #3 — B's queue consumer must read `primaryPhoneE164`.
- A imports the frozen `contracts/http/reason-codes.ts` verbatim (does not define its own `REASON_CODES`); depends on `timezone_unresolved` being present, which it is. Reason-code drift guard (M2 hardening) shipped in PR #1 — see the dedicated section below. PR #2 remap: `FAIL_CLOSED_REASON → 'compliance_unavailable'`.

## Cross-slice notes

See `docs/agent-a-handoff.md` — includes:
- **DealFlow live-schema map** (authoritative, verified against the live `railway` DB 2026-08-27): `CallQueueEntry(contactId, rank, reason, primaryMatchId)`, `Match.score` — NOT the brief's `mojoContactId/queueRank/matchFit`.
- **Test-infra posture** for the shared Railway DB: `isolate:false`, `maxWorkers:1`, `pool:'forks'`, `fileParallelism:false`, `?connection_limit=20&pool_timeout=30`, no `$disconnect()` in integration `afterAll`. Took A's suite 51 min → 145 s. Agent B adopt this for the PERF-DB property test.
- **D ↔ A collision check**: clean 2026-08-27 — D's `OAuthCredential` `db push` did not alter any A-owned table; both `OAuthCredential` + `NotifyOverflow` present, migrate status up to date.

## Test coverage

150 tests (unit + contract + integration + perf), incl. 4 reason-code drift-guard tests (below). Per-file floors 85% stmts / 85% lines / 80% branches on 9 critical-path files. Gate 1 / 2 / 3 all green. `next build` clean, `tsc --noEmit` clean.

## Reason-code drift guard (runbook M2 hardening, shipped in PR #1)

Per the integration runbook v1.2, A ships two guards so C's PR #2 enum rewrite (drop coarse `vendor_error` → re-add service-level `compliance_unavailable`) can never silently ship a stale code on the compliance-outage path:
- `PhoneVerdict.reasons` is now `ReasonCode[]` (was `string[]`); `areReasonsKnown` is a type guard; A's single fail-closed literal is the typed `FAIL_CLOSED_REASON: ReasonCode`. When the enum drops `vendor_error`, the build breaks at that line.
- Unit tests assert every reason A emits on a fail-closed path ∈ `REASON_CODES`. Verified both axes fire under a simulated C-enum swap (tsc `TS2322` + 3 red tests), then reverted.
- **PR #2 remap:** change `FAIL_CLOSED_REASON` to `'compliance_unavailable'` once C re-adds it. Do NOT map to any `vendor_error_*` variant — A never learns which vendor failed when C itself is unreachable.

## Notes for the merge

- Two additive migrations (`initial` + `add_notify_overflow`) — both applied to MAIN + PERF; squash optional.
- Importer storage falls back to local FS when R2 creds are absent; `backup.ts`/`restore-from-backup.ts` use a Prisma JSON export — swap to `pg_dump`/`pg_restore` at integration.
- pg-boss is opt-in via `USE_PGBOSS=1`; enable at integration for retry semantics.
- Playwright E2E (`tests/e2e/importer-happy-path.spec.ts`) written but not run in-slice — needs browser install + real `ANTHROPIC_API_KEY` + boot. Run at integration.

## Ready to merge

Rebased on latest `main`. **First in dependency order (A → C → B → D).** Composed boot available via `pnpm run boot:all` (health matrix across all four slices).
