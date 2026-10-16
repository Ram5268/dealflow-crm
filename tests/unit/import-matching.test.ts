import { describe, it, expect } from 'vitest'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import { BATCH, col, emitOk, importWorld, mappingOf, type FakeLead } from './helpers/fake-import-db'

// Brief 41.1 (F10) review: which existing lead a row lands on, end to end on
// the fake DB (no database). The perf-DB file tests the same rules on Postgres.
const NAME_PHONE = mappingOf(col('Name', 'Lead.name'), col('Phone', 'ContactPhone.phone'))
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

describe('a list placeholder is not a name (review item 2)', () => {
  it('a "Current Resident" row on Alice Owner\'s phone merges into her lead and doesn\'t rename it', async () => {
    const w = importWorld('Name,Phone\nCurrent Resident,212-555-0702\n')
    seed(w, { id: 'Lalice', name: 'Alice Owner', displayName: 'Alice Owner', phones: ['+12125550702'] })
    expect(await run(w, NAME_PHONE)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(lead(w, 'Lalice')).toMatchObject({ name: 'Alice Owner', displayName: 'Alice Owner' })
  })

  it('even on a confirmed same property (same street), "Unknown" never replaces the name', async () => {
    const w = importWorld('Name,Address,Phone,Status\nUnknown,"5 Oak St, Brooklyn",212-555-0705,Cold\n')
    seed(w, { id: 'Lkim', name: 'Kim Owner', displayName: 'Kim Owner', primaryAddressFull: '5 Oak St, Brooklyn, NY 11201', statusLabel: 'Hot', phones: ['+12125550705'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Kim Owner', displayName: 'Kim Owner', statusLabel: 'Cold' })
  })

  it('a lead whose name is a placeholder takes the real name from the file', async () => {
    const w = importWorld('Name,Phone\nIvy Owner,212-555-0706\n')
    seed(w, { id: 'Lph', name: 'Current Resident', displayName: 'Current Resident', phones: ['+12125550706'] })
    expect(await run(w, NAME_PHONE)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Lph')).toMatchObject({ name: 'Ivy Owner', displayName: 'Ivy Owner' })
  })
})

describe('a stored address with no street name counts as blank (review item 5)', () => {
  it('the same owner on the same phone fills it in (fill only: the status stays)', async () => {
    const w = importWorld('Name,Address,Phone,Status\nNora Owner,12 Main St,212-555-0719,Cold\n')
    seed(w, { id: 'Lnora', name: 'Nora Owner', displayName: 'Nora Owner', primaryAddressFull: '12, Brooklyn, NY', statusLabel: 'Hot', phones: ['+12125550719'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(lead(w, 'Lnora')).toMatchObject({ primaryAddressFull: '12 Main St', statusLabel: 'Hot' })
  })

  it('a city-only address on the lead and another person on the row: still a new lead', async () => {
    const w = importWorld('Name,Address,Phone,Status\nOtto Other,12 Main St,212-555-0720,Cold\n')
    seed(w, { id: 'Lnora', name: 'Nora Owner', displayName: 'Nora Owner', primaryAddressFull: 'Brooklyn, NY 11201', statusLabel: 'Hot', phones: ['+12125550720'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(lead(w, 'Lnora')).toMatchObject({ primaryAddressFull: 'Brooklyn, NY 11201', statusLabel: 'Hot' })
    expect(w.leads).toHaveLength(2)
  })

  it('a row whose address has no street name merges but never replaces the stored one', async () => {
    const w = importWorld('Name,Address,Phone\nNora Owner,"Brooklyn, NY 11201",212-555-0721\n')
    seed(w, { id: 'Lnora', name: 'Nora Owner', displayName: 'Nora Owner', primaryAddressFull: '12, Brooklyn, NY', phones: ['+12125550721'] })
    expect(await run(w, mappingOf(col('Name', 'Lead.name'), col('Address', 'Lead.primaryAddressFull'), col('Phone', 'ContactPhone.phone')))).toMatchObject({ duplicateRows: 1 })
    expect(lead(w, 'Lnora').primaryAddressFull).toBe('12, Brooklyn, NY')
  })
})
