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
| `DATABASE_URL_DEALFLOW_RO` | `railway` | DealFlow signals, **read-only** (SELECT-only client) |

Migrations: `pnpm prisma migrate deploy` (MAIN + PERF). Two additive migrations: `initial`, `add_notify_overflow`.
