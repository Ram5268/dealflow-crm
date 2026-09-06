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

## Test topology assumptions

Every DB-backed test in this repo runs from a **developer laptop against Railway
Postgres over its public TCP proxy** (`*.proxy.rlwy.net`), not over private
networking and not from a server sitting next to the database. Measured on
`DATABASE_URL_PERF`:

```
SELECT 1                     median 91.4ms   p95 97.5ms   min 84.9ms
EXPLAIN ANALYZE (ammunition) planning 0.3-0.6ms  execution 0.04-0.06ms
```

**~96% of any measured query time is round-trip network, not work.** A statement
that does nothing costs ~91ms; the ammunition hydration join costs ~4ms on top
of that.

### What this means for tests

- **Never assert on absolute wall-clock latency.** A threshold like "p95 <
  200ms" is a measurement of the developer's internet connection with about two
  round trips of headroom. It fails whenever the link or the DB is busy — and
  it passes an N+1 regression, because one extra round trip (+91ms) still lands
  under 200ms on a quiet day. It generates flake without generating signal.
- **Assert on marginal cost instead**: elapsed time minus a same-connection
  `SELECT 1` baseline, sampled interleaved so drift biases both equally. That
  number is topology-independent and an added round trip blows it everywhere.
  `tests/ammunition.latency.test.ts` is the worked example.
- Absolute numbers are still worth **logging** — just not gating.

### Before deploying

The product latency budgets in `briefs/BRIEF_B.md` (ammunition endpoint p95
<100ms, contributing to a <200ms `call.connected` → panel-visible budget) assume
the app server is **adjacent to the database**. They are not achievable across
the public proxy: hydration alone cannot beat the ~91ms floor.

Any pre-deploy work must re-audit absolute wall-clock thresholds against the
real production topology, and confirm the app and the database share a private
network before treating those budgets as met. Do not read a green test suite as
evidence that the 200ms panel budget holds.
