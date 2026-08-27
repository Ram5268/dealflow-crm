# Observability

## Correlation IDs

Every request carries `x-correlation-id` (middleware reads or mints it; `withRoute` binds it into async-local-storage). Logs, Sentry captures, and emitted event payloads all carry it, so a single request is traceable end-to-end across HTTP → handler → NOTIFY → consumer.

## pino logs (JSON in prod, pretty in dev)

`src/lib/logger` — level via `LOG_LEVEL` (default `info`). Sample line (dev pretty format):

```
[2026-08-27 12:29:56 -0400] ERROR (45490): exception
    correlationId: "11111111-1111-4111-8111-111111111111"
    dependency: "compliance.callable-now"
    event: "batch-failure"
    err: "ETIMEDOUT"
```

Every failure logs `{ correlationId, event, dependency, err, stack }`.

## Sentry seam

`src/lib/shared/sentry.ts` — `captureException` / `captureWarning`. During isolated build `SENTRY_DSN` is unset, so captures are structured pino lines (correlationId attached). At integration, wire the real `@sentry/nextjs` client at the two call sites; every route handler already funnels unhandled errors through `withRoute` → `captureException`.

Fail-closed / contract-drift signals that emit Sentry warnings:
- compliance 5xx/timeout/malformed → `captureException` (connectivity), sets `stale`.
- compliance returned a reason outside `REASON_CODES` → `captureWarning("compliance returned unknown REASON_CODE")`, does NOT set `stale`.
- compliance omitted a submitted phone id → `captureWarning`, phone fail-closed.
- DealFlow RO unreachable → `captureException`, existing signals preserved, cron returns 503.

## Health

`GET /api/core-data/health` → `{ status: "ok"|"degraded"|"down", checks: { db, dealflowRo, anthropic, r2 }, timestamp }`. `db` down → `down` (503); `dealflowRo` down → `degraded`.
