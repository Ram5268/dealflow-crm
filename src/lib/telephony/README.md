# Agent B — Telephony & Dial Engine

WebRTC softphone + adaptive-pacing power/predictive dialer. Owns `DialSession`,
`Call`, `CallLeg`, `PacingMetric`. Consumes Agent A's queue and Agent C's
compliance check; emits `call.connected` / `call.completed` /
`dial-session.pacing-update` on the `crm_call` channel.

## Architecture (data flow)

```
/dialer UI ──POST /dial-sessions──▶ createDialSession (predictive gate, halt 503)
                                          │
             pacing worker (60s) ◀────────┤ DialSession(active)
             rolling abandonment/AMD-FP/spend → computeNewLineCount
             → adjust lineCount, emit pacing-update, halt on >2.8%/spend
                                          │
   dial tick: getQueue(A) → eligibleLeads(72h dropped-loser) → checkCallable(C, fail-closed)
              → placeCall (Twilio-first) ─┐
                                          ▼
        Twilio ──webhook/voice(AMD)──▶ race resolver (advisory lock)
                    winner → Conference + emit call.connected → ammunition panel (SSE)
                    loser  → dropped-loser TwiML + abandoned metric
                 ──webhook/status────▶ emit call.completed (emittedAt guard)
                 ──webhook/recording─▶ store MP3 in R2
        reconciliation (5m): stuck-converge · orphan-cancel · lost-emission re-emit
```

## Key files

| Area | File |
|---|---|
| Pacing control law (pure) | `pacing/computeNewLineCount.ts` |
| Pacing worker / rolling calc | `pacing/worker.ts`, `pacing/metrics.ts` |
| Circuit breaker | `pacing/haltState.ts` (sentinel rows) |
| Race resolver | `race-resolver/acquireWinner.ts`, `race-resolver/droppedLoser.ts` |
| Twilio | `twilio/{client,signature,statusMap,amd,twiml,voiceWebhook,statusWebhook,recording,voiceToken}.ts` |
| Dial loop | `dial-loop/{queueClient,compliance,nextContact,session,placeCall}.ts` |
| Reconciliation | `reconciliation/job.ts` |
| Ammunition hydrate | `ammunition/hydrate.ts` (single JOIN, <200ms) |
| Softphone (headless logic) | `softphone/controller.ts` |
| Events | `events/emit.ts` (pg_notify) |

## Run locally

```bash
corepack pnpm@9 install && corepack pnpm@9 exec prisma generate
# Terminal 1 — cross-slice mocks (Gate 1 isolation)
pnpm mocks:up                       # queue :4101, compliance :4102
# Terminal 2 — the slice
QUEUE_SERVICE_BASE_URL=http://localhost:4101 \
COMPLIANCE_BASE_URL=http://localhost:4102 \
doppler run --config dev -- pnpm dev
```

## Tests

```bash
pnpm test            # all suites
pnpm test:coverage   # enforces Gate-3 floors (90% pacing + race-resolver, 80% rest)
```

- DB-backed tests run against **Railway `DATABASE_URL_PERF`** (`dealflow_crm_perf`),
  not Docker/Testcontainers. The schema is pushed once via `tests/setup/globalSetup.ts`.
- **`fileParallelism: false`** in `vitest.config.ts` is REQUIRED, not a perf
  oversight: DB-backed tests share one perf DB and a few touch the GLOBAL halt
  sentinel (`pacing/haltState.ts`). Running files in parallel workers would race
  on that shared state. Do NOT re-enable file parallelism looking for a speedup.
  (Matches Agent A's `isolate:false, maxWorkers:1` posture.)

## Real Twilio test creds

Set `TWILIO_ACCOUNT_SID/AUTH_TOKEN/API_KEY_SID/API_KEY_SECRET` (test creds work)
+ a tunnel URL in `TWILIO_VOICE_WEBHOOK_BASE`. See `docs/smoke-tests/telephony.md`.
