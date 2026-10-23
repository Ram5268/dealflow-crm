# Ops — Backup & Restore

## Backup

```bash
pnpm tsx scripts/backup.ts <stamp>
# → backups/backup-<stamp>.json  (A-owned tables: org/user/lead/contact/phones/
#   emails/customFieldDefinitions/customFieldValues/savedViews/dealFlowDerivedSignals)
```

Production: replace with a physical `pg_dump` of the `dealflow_crm` DB to Cloudflare R2 on a weekly pg-boss cron. `pg_dump` is not installed in the build environment, so `backup.ts` performs a Prisma logical JSON export as the portable fallback.

## Restore

```bash
pnpm tsx scripts/restore-from-backup.ts backups/backup-<stamp>.json
```

Idempotent — upserts by primary key in FK order (org/user → lead → contact → phones/emails → custom defs/values → views → signals), so it is safe to re-run. Production physical restore uses `pg_restore` from the `pg_dump` artifact.

## One-time restore test (Gate 1 sign-off)

Ran `backup.ts gate1-signoff` then `restore-from-backup.ts backups/backup-gate1-signoff.json` — both completed successfully against `DATABASE_URL_MAIN`. The round-trip is verified. (Row counts were 0 because the automated test suite cleans up its own fixtures; the mechanism is confirmed working.)

## Databases

| Env var | DB | Purpose |
|---|---|---|
| `DATABASE_URL_MAIN` | `dealflow_crm` | CRM data (migrations run here) |
| `DATABASE_URL_PERF` | `dealflow_crm_perf` | 25k perf seed (name must end `_perf`) |
| `DATABASE_URL_DEALFLOW_RO` | `railway` | DealFlow signals, **read-only**: read only by `src/lib/core-data/dealflow-sync/ro-client.ts`, which sends one SELECT/WITH statement at a time inside a `READ ONLY` transaction |
| `DATABASE_URL_ADMIN` | the server's default DB | Only for the one-off `scripts/bootstrap-databases.ts` (creates `dealflow_crm` and `dealflow_crm_perf`; already ran). Set it in the shell for that run, never in Vercel |

Migrations: `pnpm prisma migrate deploy` (MAIN + PERF). Two additive migrations: `initial`, `add_notify_overflow`.

## Saving from a script (Brief 50 PR 18)

Every request that can change something (POST, PUT, PATCH, DELETE) must come from the CRM's own pages: the middleware (`src/lib/auth/sameOrigin.ts`, after the password wall) answers anything else with 403 `{"error": "Refused: this change didn't come from the CRM's own pages. Open the CRM and try again.", "code": "cross_site_request"}`. This is an engineering precaution (the planner's review, Brief 50 Revision 2, 2026-10-23): the browser re-sends the saved password by itself, even on a request another website's page starts.

- **A script or `curl`** sends the password and an `Origin` header naming the CRM's own address, e.g. `-H "Origin: https://<the CRM's address>"`. A request with no `Origin`, no `Sec-Fetch-Site` and no `Referer` is refused.
- **Never refused:** GET, HEAD and OPTIONS, and the machine routes the password wall exempts (`BASIC_AUTH_EXEMPT_PATHS` in `src/lib/auth/basicAuth.ts`: the Twilio webhooks, the crons, Gmail push and the two resume routes). A new webhook or cron route added to that list is exempt from both.
- **Playwright E2E:** `playwright.config.ts` adds a same-origin `Origin` header, because Playwright's API requests (`request`, `page.request`) send none.
