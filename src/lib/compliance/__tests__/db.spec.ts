import { describe, it, expect } from 'vitest'
import { resolveDb, prisma } from '@/lib/compliance/db'

describe('resolveDb', () => {
  it('returns the injected client when provided', () => {
    const fake = { marker: true }
    expect(resolveDb(fake)).toBe(fake)
  })
  it('falls back to the shared Prisma singleton when undefined', () => {
    expect(resolveDb<typeof prisma>(undefined)).toBe(prisma)
  })
})
