# Known schema drift — expected, do not "fix"

`prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma`
does not come back empty against a correctly-migrated database. Four tables
always report a changed `id` default. **This is cosmetic and permanent.** It is
not unapplied drift and there is nothing to migrate.

## The four

`Call`, `CustomFieldDefinition`, `DialSession`, `SavedView` — each reports:

```
[*] Altered column `id` (default changed from
      Some(DbGenerated(Some("'call_' || substr(md5(random()::text), 1, 24)")))
    to
      Some(DbGenerated(Some("('call_'::text || substr(md5((random())::text), 1, 24))"))))
```

(with `cf_`, `dial_`, `save_` for the other three.)

## Why it is not real

The two expressions are the same expression. Postgres parses the default,
normalises it, and stores its own rendering — adding the explicit `::text` cast
and parenthesising `(random())`. Prisma compares the schema's *source text*
against Postgres's *normalised text*, so they never match.

## Why you must not try to clear it

Applying the "fix" is a no-op that reintroduces itself:

```sql
ALTER TABLE "Call" ALTER COLUMN "id"
  SET DEFAULT 'call_' || substr(md5(random()::text), 1, 24);
```

Postgres re-normalises on write, and the next `migrate diff` prints the same
four entries. A migration written to silence this would run forever without
converging.

## What real drift looks like

Real drift names columns and indexes, not just a default re-print. The last
genuine case was `BulkScrubCheckpoint`, where the live table still carried an
older draft (`lastProcessedPhone`, `startedAt`, nullable `importBatchId`) while
`src/lib/compliance/bulk/worker.ts` and `checkpoint.ts` read and wrote
`lastProcessedContactPhoneId`, `chunkIndex` and `haltReason`. Bulk-scrub resume
was broken against the live DB and passed CI only because the unit tests inject
fakes. Fixed by `prisma/migrations/20260906000000_bulk_scrub_checkpoint_align`.

So: if a diff mentions **only** those four `id` defaults, the database is in
sync. If it names anything else, investigate.

## House rules for this repo

- **Never `prisma migrate dev`** — hand-write the migration and apply it with
  `prisma migrate deploy`.
- **Never pass a real database URL to `--shadow-database-url`** — Prisma resets
  the shadow database, destroying whatever is in it.
- Prisma's datasource here is `env("DATABASE_URL_MAIN")`, not `DATABASE_URL`.
