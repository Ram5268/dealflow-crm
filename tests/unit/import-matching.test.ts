import { describe, it, expect } from 'vitest'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import { BATCH, col, emitOk, importWorld, mappingOf, type FakeLead } from './helpers/fake-import-db'

// Brief 41.1 (F10) review: which existing lead a row lands on, end to end on
// the fake DB (no database). The perf-DB file tests the same rules on Postgres.
const NAME_ADDR_PHONE_STATUS = mappingOf(col('Name', 'Lead.name'), col('Address', 'Lead.primaryAddressFull'), col('Phone', 'ContactPhone.phone'), col('Status', 'Lead.statusLabel'))

type World = ReturnType<typeof importWorld>
const seed = (w: World, l: Partial<FakeLead> & { id: string; phones: string[] }) =>
  w.leads.push({
    seq: 0, by: 'seed', name: null, displayName: 'Imported Lead', primaryAddressFull: null, mojoId: null, statusLabel: null,
    contacts: [{ id: `c_${l.id}`, name: l.name ?? null, displayName: l.displayName ?? l.name ?? 'Imported Lead' }],
    ...l,
  } as FakeLead)
const run = (w: World, mapping = NAME_ADDR_PHONE_STATUS) => commitImport(BATCH, 'merge', mapping, 'c', { db: w.db('run'), emit: emitOk })
const lead = (w: World, id: string) => w.leads.find((l) => l.id === id)!

describe('another unit is another property (review item 1)', () => {
  it('a 5A row on the 4B lead\'s phone becomes its own lead; 4B keeps its status', async () => {
    const w = importWorld('Name,Address,Phone,Status\nDan Sample,"123 Main St 5A, Brooklyn, NY",212-555-0604,Cold\n')
    seed(w, { id: 'L4B', name: 'Dan Sample', displayName: 'Dan Sample', primaryAddressFull: '123 Main St 4B, Brooklyn, NY', statusLabel: 'Hot', phones: ['+12125550604'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(lead(w, 'L4B')).toMatchObject({ primaryAddressFull: '123 Main St 4B, Brooklyn, NY', statusLabel: 'Hot' })
    expect(w.leads).toHaveLength(2)
  })

  it('the same unit written with a marker is the same property: it merges', async () => {
    const w = importWorld('Name,Address,Phone,Status\nDan Sample,"123 Main St Apt 4B, Brooklyn",212-555-0604,Cold\n')
    seed(w, { id: 'L4B', name: 'Dan Sample', displayName: 'Dan Sample', primaryAddressFull: '123 Main St 4B, Brooklyn, NY', statusLabel: 'Hot', phones: ['+12125550604'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(lead(w, 'L4B').statusLabel).toBe('Cold') // a confirmed same property may update its status
  })
})

describe('a one-cell address with a direction-word town is the same street (review item 4)', () => {
  it('"100 Main St East Elmhurst NY 11369" lands on the lead at "100 Main St, East Elmhurst, NY 11369"', async () => {
    const w = importWorld('Name,Address,Phone,Status\nAnn Lee,100 Main St East Elmhurst NY 11369,212-555-0703,Cold\n')
    seed(w, { id: 'Lann', name: 'Ann Lee', displayName: 'Ann Lee', primaryAddressFull: '100 Main St, East Elmhurst, NY 11369', statusLabel: 'Hot', phones: ['+12125550703'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
  })
})
