## Summary

Agent B — **Telephony & Dial Engine slice**: WebRTC softphone + adaptive-pacing power/predictive dialer. 6 milestones green:

- **M1a — pacing control law** (`computeNewLineCount.ts`): pure, half-open abandonment bands (<1.5% increase · [1.5,2.0) hold · [2.0,2.5) decrease · [2.5,2.8) force-single · ≥2.8% halt), spend-cap-first ordering, AMD-FP shave. 100% branch.
- **M1b — two-legs race resolver** (`acquireWinner.ts` / `droppedLoser.ts`): Postgres `pg_try_advisory_xact_lock` picks exactly one winning leg; loser gets dropped-loser TwiML. Proven at N=50 concurrent against real Railway Postgres.
- **M2 — Twilio integration**: async AMD parse, webhook signature validation, status mapping, TwiML builders, Voice SDK JWT.
- **M3 — softphone / conference / ammunition**: headless `SoftphoneController`, conference bridge, single-JOIN ammunition hydrate (<200 ms p95).
- **M4 — dial loop + pacing worker + circuit breaker**: `runDialTick` (queue → eligibleLeads → fail-closed compliance → placeCall), 60 s `runPacingTick`, sentinel-row halt/resume.
- **M5 — reconciliation + R2 recordings + cost cap**: stuck-converge / orphan-cancel / lost-emission re-emit; R2 store + presign; month-to-date spend cap.
- **M6 — contract tests + cross-slice mocks**: faithful queue (:4101) + compliance (:4102) HTTP mocks; both-direction wire assertions.

Gate 1 (isolation boot with mocks) · Gate 2 (contract tests both directions) · Gate 3 (171 tests, coverage floors CI-enforced: **90% pacing + race-resolver, 80% rest**). `tsc --noEmit` clean.

## Contract exposures (this slice)

- **Emits** (channel `crm_call`, all carry a `type` discriminant): `call.connected`, `call.completed`, `dial-session.pacing-update`. `cost` on `call.completed` is DECIMAL-AS-STRING.
- **Consumes**: `GET /api/queue` (A) — reads `primaryPhoneE164` + `primaryPhoneId`; `POST /api/compliance/callable-now` (C) — sends `{ contactPhoneIds:[id] }`, FAIL-CLOSED on any error/timeout/malformed.
- **HTTP**: `POST /telephony/dial-sessions`, `GET /telephony/health`, `GET /telephony/stream` (SSE), `POST /telephony/pacing/resume`, `GET /telephony/pacing/status`, `POST /telephony/voice/conference`, `POST /telephony/calls/token`, `GET /telephony/calls/:id/ammunition`, `GET /telephony/calls/:id/recording` (302→presigned), `POST /telephony/webhook/{voice,status,recording}`.

## §13 amendments in this slice

All four blessed as additive by Ryan; tracked in `docs/schema-drift-pending.md`:

- **S1 — `CallLeg @@unique([callId, providerLegSid])`** (B-owned). Composite unique so a re-delivered webhook can't double-insert a leg. **Included in this PR's migration** (applied at the rebase, post A+C).
- **S2 — `Call.source` default `"Close.io"` → `"dealflow-crm"`** (B-owned). **Included in this PR's migration.** Once live, the explicit `source:"dealflow-crm"`-on-insert workaround is dropped.
- **S3 — Twilio status mapping** (`statusMap.ts`): `canceled → cancel`; unknown → `null` + warn.
- **S4 — `call.completed.disposition` gains `'no-answer'`**: Twilio `no-answer → no-answer` (not `error`); `failed`/`cancel`/`timeout → error`.
- **S5 — `dial-session.pacing-update` shape** (blessed 2026-08-27): `{ type, callId?, sessionId, lineCount, rollingAbandonment, band('below_1_5'|'1_5_to_2_0'|'2_0_to_2_5'|'2_5_to_2_8'|'above_2_8'), reason, correlationId }`. Kept `type` for `crm_call` consistency; added `band`+`reason` for Ops. No shipped consumer depended on the prior shape.

`Call.emittedAt` was already in the frozen schema — moot, no migration.

## Cross-slice notes

- **Tolerant-consumer stance on REASON_CODES**: B imports the frozen `contracts/http/reason-codes.ts` as source of truth and Sentry-warns on any value outside it — still fail-closed. C's PR #2 re-adds `compliance_unavailable` + the granular 19-code enum; B converges automatically with no code change.
- **Test-infra posture** (adopted from A's handoff): DB-backed tests hit the shared Railway **`DATABASE_URL_PERF`** (`dealflow_crm_perf`), NOT Docker/Testcontainers. Schema pushed once via `tests/setup/globalSetup.ts`. **`fileParallelism: false` is REQUIRED, not a perf oversight** — DB-backed tests share one perf DB and several touch the GLOBAL halt sentinel (`pacing/haltState.ts`); parallel workers would race on it. Do not re-enable.
- **Halt-reason encoding bug caught in-slice**: `setHalt` encodes its reason in the sentinel row's `amdFalsePositive` field; `rollingAbandonment` was summing it. Fixed by excluding `SYSTEM_ORG` ("system") from all rolling aggregations — otherwise abandonment reads high and the breaker trips spuriously.
- vitest `@` alias needs `fileURLToPath` (the iCloud repo path has spaces → `%20` breaks `new URL().pathname`).

## Test coverage

171 tests (unit + contract + integration + property). Race-resolver atomicity proven at N=50 concurrent transactions against real Railway Postgres (barrier holds all txns open simultaneously for genuine advisory-lock contention). Coverage floors machine-enforced via `vitest.config.ts` thresholds (`pnpm test:coverage`, exit 0). `tsc --noEmit` clean, no iCloud ` 2.ts` duplicates, no `.env` committed.

## Notes for the merge

- **Two workarounds retire at this rebase** once S1/S2 migrations land: the explicit `source:"dealflow-crm"`-on-insert (S2) and the SELECT-then-INSERT leg guard becomes constraint-backed (S1).
- Confirm the queue consumer reads **`primaryPhoneE164`** (A's §13 #15 rename), not `primaryPhone`.
- Confirm `COMPLIANCE_BASE_URL` env name (not `COMPLIANCE_SERVICE_BASE_URL`).
- **Deferred device smoke (owed by Ryan, env drop-in, no code change):** Twilio test SID/token + verified caller ID → `worktrees/agent-b/.env`; `cloudflared` tunnel URL → `TWILIO_VOICE_WEBHOOK_BASE`. Runbook: `docs/smoke-tests/telephony.md`. Predictive (multi-line) sessions stay REFUSED with `loser_twiml_unapproved` until `LOSER_TWIML_APPROVED=true` (FCC abandoned-call belt+suspenders).
- **Wire-shape audit before first PRODUCTION dial** (5 min, `docs/smoke-tests/telephony.md`): assert `call.completed.type` present + `cost` is a string; `/api/queue` returns `primaryPhoneE164`; every `callable-now` `reasons[]` value ∈ REASON_CODES.

## Ready to merge

Rebased on latest `main` (post A + C). **Third in dependency order (A → C → B → D).** Composed boot available via `pnpm run boot:all` (health matrix across all four slices).
