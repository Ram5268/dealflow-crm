import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { importIdOf, importIdsOf, sourceLabel, type Uploads } from '@/lib/ui/source'
import { loadUploads } from '@/lib/core-data/leads/uploads'

// Brief 50 PR 14 (open item 6.16): a lead's Source reads in words. The
// importer stores "import:<importBatchId>", which showed as a raw id on the
// lead page and the leads table. Made-up ids and file names only.

// 02:30 UTC on Oct 19 is 10:30 pm on Oct 18 in New York: the date is New York's.
const UPLOADS: Uploads = {
  imp_1: { label: 'Mojo Export', filename: 'test-sellers.csv', createdAt: '2026-10-19T02:30:00.000Z' },
  imp_nolabel: { label: '  ', filename: 'last-year.xlsx', createdAt: '2025-03-04T16:00:00.000Z' },
  imp_bad: { label: 'Mojo Export', filename: 'x.csv', createdAt: 'not a date' },
}

describe('sourceLabel', () => {
  it('an upload reads as the Source label typed on the Import page, never the raw id', () => {
    expect(sourceLabel('import:imp_1', UPLOADS)).toBe('Mojo Export')
  })

  it('in detail (the lead page, the table hover) it adds the New York date and the file', () => {
    expect(sourceLabel('import:imp_1', UPLOADS, { detail: true })).toBe('Mojo Export · uploaded Oct 18, 2026 · test-sellers.csv')
    expect(sourceLabel('import:imp_bad', UPLOADS, { detail: true })).toBe('Mojo Export · uploaded · x.csv')
  })

  it('an upload with a blank label reads by its date', () => {
    expect(sourceLabel('import:imp_nolabel', UPLOADS)).toBe('Uploaded Mar 4, 2025 · last-year.xlsx')
  })

  it('an upload it cannot look up reads "Upload", not the id', () => {
    expect(sourceLabel('import:imp_gone', UPLOADS)).toBe('Upload')
    expect(sourceLabel('import:imp_gone', undefined, { detail: true })).toBe('Upload')
    expect(sourceLabel('import:', UPLOADS)).toBe('Upload')
  })

  it('a lead added in the CRM says so; other text and blanks pass through', () => {
    expect(sourceLabel('manual')).toBe('Added by hand')
    expect(sourceLabel('Referral from a neighbour')).toBe('Referral from a neighbour')
    expect(sourceLabel(null)).toBeNull()
    expect(sourceLabel(undefined)).toBeNull()
    expect(sourceLabel('  ')).toBeNull()
  })
})

describe('import ids', () => {
  it('reads the id out of "import:<id>" and nothing else', () => {
    expect(importIdOf('import:imp_1')).toBe('imp_1')
    expect(importIdOf('import:')).toBeNull()
    expect(importIdOf('manual')).toBeNull()
    expect(importIdOf(null)).toBeNull()
  })

  it('lists each import once', () => {
    expect(importIdsOf(['import:imp_1', 'manual', null, 'import:imp_1', 'import:imp_2'])).toEqual(['imp_1', 'imp_2'])
  })
})

describe('loadUploads', () => {
  it('one query, scoped to the organization, keyed by import id', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'imp_1', sourceLabel: 'Mojo Export', filename: 'test-sellers.csv', createdAt: new Date('2026-10-19T02:30:00.000Z') },
    ])
    const db = { importBatch: { findMany } } as unknown as PrismaClient
    const out = await loadUploads('org_test', ['import:imp_1', 'import:imp_1', 'manual', null], db)
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_test', id: { in: ['imp_1'] } },
      select: { id: true, sourceLabel: true, filename: true, createdAt: true },
    })
    expect(out).toEqual({ imp_1: { label: 'Mojo Export', filename: 'test-sellers.csv', createdAt: '2026-10-19T02:30:00.000Z' } })
  })

  it('no uploads named: no query', async () => {
    const findMany = vi.fn()
    const db = { importBatch: { findMany } } as unknown as PrismaClient
    expect(await loadUploads('org_test', ['manual', null], db)).toEqual({})
    expect(findMany).not.toHaveBeenCalled()
  })
})
