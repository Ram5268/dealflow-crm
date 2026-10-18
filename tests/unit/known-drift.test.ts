import { describe, it, expect } from 'vitest'
import { KNOWN_DRIFT_STATEMENTS, unexpectedDrift } from '@/lib/shared/known-drift'

// Brief 45 PR A — CI applies every migration to an empty database and diffs it
// against schema.prisma. Only the four cosmetic `id` defaults in
// docs/known-drift.md may differ; anything else fails the job.
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

  it('accepts the four, some of them, or an empty diff', () => {
    expect(unexpectedDrift(FOUR)).toEqual([])
    expect(unexpectedDrift(FOUR.split('\n').slice(0, 5).join('\n'))).toEqual([])
    expect(unexpectedDrift('-- This is an empty migration.\n')).toEqual([])
    expect(unexpectedDrift('')).toEqual([])
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
    expect(unexpectedDrift(real)).toEqual(['CREATE TABLE "Folder" (', '"id" TEXT NOT NULL', ');', 'ALTER TABLE "ImportBatch" ADD COLUMN "targetListId" TEXT;'])
    // A changed default on one of the four tables is still drift.
    expect(unexpectedDrift(`ALTER TABLE "Call" ALTER COLUMN "id" SET DEFAULT 'x';`)).toHaveLength(1)
  })
})
