import 'dotenv/config'
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'

// Connects to DATABASE_URL_MAIN and runs a trivial query. Skips if MAIN is unset.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN

describe.runIf(enabled)('prisma connectivity (MAIN)', () => {
  afterAll(async () => {
  })

  it('runs SELECT 1', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      'SELECT 1::int AS n'
    )
    expect(rows[0].n).toBe(1)
  })

  it('Lead table exists and is queryable', async () => {
    const count = await prisma.lead.count()
    expect(typeof count).toBe('number')
  })
})
