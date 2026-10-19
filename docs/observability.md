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

**Not wired yet (Brief 50 PR 2, 2026-10-19):** no `SENTRY_DSN` is set anywhere visible, so `@sentry/nextjs` is never initialised and every capture stays a pino line. Turning it on needs a DSN in Vercel plus a small follow-up (SDK init in `instrumentation.ts` / `instrumentation-client.ts`, un-comment the two calls in `sentry.ts`).

## Error pages (Brief 50 PR 2)

A page that throws shows `src/app/error.tsx` inside the app shell (the lead page has its own, `src/app/leads/[id]/error.tsx`); a broken root layout shows `src/app/global-error.tsx`, which brings its own `<html>`/`<body>` and theme. All three come from `src/components/ErrorScreen.tsx`: a plain-English title, "Try again" (Next 16.2's `unstable_retry`, which re-reads the page from the server; `reset` when that's absent), a link back, and Next's error digest as "Reference" — never the message or stack. They log one `[error page: …]` line to the browser console; the server's log line for the same error carries the same digest. Unknown URLs show `src/app/not-found.tsx`.

## Health

`GET /api/core-data/health` → `{ status: "ok"|"degraded"|"down", checks: { db, dealflowRo, anthropic, r2 }, timestamp }`. `db` down → `down` (503); `dealflowRo` down → `degraded`.
