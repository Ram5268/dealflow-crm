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

export interface DriftCheck {
  /** Lines (trimmed) that are neither a comment, blank, nor one of the four. */
  unexpected: string[]
  /** Which of the four are absent. */
  missing: string[]
}

/**
 * Reads a `prisma migrate diff --script` output. The database matches the
 * schema only when nothing is unexpected AND all four known lines are there:
 * Postgres always prints them for a migrated database, so a diff without them
 * (an empty file, a diff that never ran against one) must not count as a pass.
 */
export function checkKnownDrift(diffSql: string): DriftCheck {
  const lines = diffSql
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))
  const known = new Set(KNOWN_DRIFT_STATEMENTS)
  return {
    unexpected: lines.filter((line) => !known.has(line)),
    missing: KNOWN_DRIFT_STATEMENTS.filter((statement) => !lines.includes(statement)),
  }
}
