// Brief 45 (PR A): the schema drift that is expected and cosmetic, so CI can
// tell it apart from a real one. See docs/known-drift.md: Postgres re-renders
// these four `id` defaults, so `prisma migrate diff` against a correctly
// migrated database always prints them. Anything else in that diff means the
// migrations don't build the schema the code expects. Pure: no I/O.

export const KNOWN_DRIFT_STATEMENTS: readonly string[] = [
  `ALTER TABLE "Call" ALTER COLUMN "id" SET DEFAULT 'call_' || substr(md5(random()::text), 1, 24);`,
  `ALTER TABLE "CustomFieldDefinition" ALTER COLUMN "id" SET DEFAULT 'cf_' || substr(md5(random()::text), 1, 24);`,
  `ALTER TABLE "DialSession" ALTER COLUMN "id" SET DEFAULT 'dial_' || substr(md5(random()::text), 1, 24);`,
  `ALTER TABLE "SavedView" ALTER COLUMN "id" SET DEFAULT 'save_' || substr(md5(random()::text), 1, 24);`,
]

// The lines of a `prisma migrate diff --script` output that are neither a
// comment, blank, nor one of the four known statements (trimmed). Empty means
// the database matches the schema.
export function unexpectedDrift(diffSql: string): string[] {
  const known = new Set(KNOWN_DRIFT_STATEMENTS)
  return diffSql
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--') && !known.has(line))
}
