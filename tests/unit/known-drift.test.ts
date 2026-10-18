import { describe, it, expect } from 'vitest'
import { KNOWN_DRIFT_STATEMENTS, checkKnownDrift } from '@/lib/shared/known-drift'

// Brief 45 PR A — CI applies every migration to an empty database and diffs it
// against schema.prisma. Only the four cosmetic `id` defaults in
// docs/known-drift.md may differ, and all four must be there; anything else
// fails the job.
const FOUR = `-- AlterTable
ALTER TABLE "Call" ALTER COLUMN "id" SET DEFAULT 'call_' || substr(md5(random()::text), 1, 24);

-- AlterTable
ALTER TABLE "CustomFieldDefinition" ALTER COLUMN "id" SET DEFAULT 'cf_' || substr(md5(random()::text), 1, 24);

-- AlterTable
ALTER TABLE "DialSession" ALTER COLUMN "id" SET DEFAULT 'dial_' || substr(md5(random()::text), 1, 24);

-- AlterTable
ALTER TABLE "SavedView" ALTER COLUMN "id" SET DEFAULT 'save_' || substr(md5(random()::text), 1, 24);
`

describe('known schema drift (docs/known-drift.md)', () => {
  it('lists exactly the four cosmetic id defaults', () => {
    expect(KNOWN_DRIFT_STATEMENTS.map((s) => s.match(/^ALTER TABLE "(\w+)"/)?.[1])).toEqual(['Call', 'CustomFieldDefinition', 'DialSession', 'SavedView'])
  })

  it('passes with exactly the four', () => {
    expect(checkKnownDrift(FOUR)).toEqual({ unexpected: [], missing: [] })
    expect(checkKnownDrift(FOUR.replace(/\n/g, '\r\n'))).toEqual({ unexpected: [], missing: [] })
  })

  it('an empty diff, or one with only some of the four, does not pass', () => {
    expect(checkKnownDrift('').missing).toHaveLength(4)
    expect(checkKnownDrift('-- This is an empty migration.\n').missing).toHaveLength(4)
    const onlyCall = FOUR.split('\n').slice(0, 3).join('\n')
    expect(checkKnownDrift(onlyCall)).toEqual({ unexpected: [], missing: KNOWN_DRIFT_STATEMENTS.slice(1) })
  })

  it('reports anything else, line by line', () => {
    const real = `${FOUR}
-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL
);
-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN "targetListId" TEXT;
`
    expect(checkKnownDrift(real)).toEqual({
      unexpected: ['CREATE TABLE "Folder" (', '"id" TEXT NOT NULL', ');', 'ALTER TABLE "ImportBatch" ADD COLUMN "targetListId" TEXT;'],
      missing: [],
    })
    // A changed default on one of the four tables is still drift, and that table's known line is missing.
    const changed = FOUR.replace(`'call_' || substr(md5(random()::text), 1, 24)`, `'x'`)
    expect(checkKnownDrift(changed)).toEqual({
      unexpected: [`ALTER TABLE "Call" ALTER COLUMN "id" SET DEFAULT 'x';`],
      missing: [KNOWN_DRIFT_STATEMENTS[0]],
    })
  })
})
