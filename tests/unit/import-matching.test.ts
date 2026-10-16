import { describe, it, expect } from 'vitest'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import { BATCH, col, emitOk, importWorld, mappingOf, type FakeLead } from './helpers/fake-import-db'

// Brief 41.1 (F10) review: which existing lead a row lands on, end to end on
// the fake DB (no database). The perf-DB file tests the same rules on Postgres.
const NAME_PHONE = mappingOf(col('Name', 'Lead.name'), col('Phone', 'ContactPhone.phone'))
const MOJO_NAME_ADDR_PHONE_STATUS = mappingOf(col('Mojo', 'Lead.mojoId'), col('Name', 'Lead.name'), col('Address', 'Lead.primaryAddressFull'), col('Phone', 'ContactPhone.phone'), col('Status', 'Lead.statusLabel'))
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

describe("other names on the same street and phone: one lead, blanks filled only (review item 3, Ryan's decision)", () => {
  it('co-owners on separate rows make one lead; the second never renames it or changes its status', async () => {
    const w = importWorld('Name,Address,Phone,Status\nJohn Smith,"5 Oak St, Brooklyn, NY",212-555-0700,Hot\nMary Smith,"5 Oak St, Brooklyn, NY",212-555-0700,Cold\n')
    expect(await run(w)).toMatchObject({ totalRows: 2, importedRows: 2, duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(w.leads[0]).toMatchObject({ name: 'John Smith', displayName: 'John Smith', statusLabel: 'Hot' })
  })

  it('"ROBERT SMITH" from a list lands on the hand-typed "Bob Smith" at the same street; name and status stay', async () => {
    const w = importWorld('Name,Address,Phone,Status\nROBERT SMITH,"5 Oak St, Brooklyn, NY",212-555-0701,Cold\n')
    seed(w, { id: 'Lbob', displayName: 'Bob Smith', primaryAddressFull: '5 Oak St, Brooklyn, NY', statusLabel: 'Hot', phones: ['+12125550701'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(lead(w, 'Lbob')).toMatchObject({ name: null, displayName: 'Bob Smith', statusLabel: 'Hot' })
  })

  it('it fills what the lead lacks (a status, a Mojo ID)', async () => {
    const w = importWorld('Mojo,Name,Address,Phone,Status\nM_TRUST,Smith Family Trust,"5 Oak St, Brooklyn",212-555-0707,Warm\n')
    seed(w, { id: 'Ljohn', name: 'John Smith', displayName: 'John Smith', primaryAddressFull: '5 Oak St, Brooklyn, NY 11201', phones: ['+12125550707'] })
    expect(await run(w, MOJO_NAME_ADDR_PHONE_STATUS)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Ljohn')).toMatchObject({ name: 'John Smith', primaryAddressFull: '5 Oak St, Brooklyn, NY 11201', statusLabel: 'Warm', mojoId: 'M_TRUST' })
  })

  it('a lead at the same street with the same name is preferred over one with another name', async () => {
    const w = importWorld('Name,Address,Phone,Status\nMary Smith,"5 Oak St, Brooklyn",212-555-0708,Cold\n')
    seed(w, { id: 'Ljohn', seq: 1, name: 'John Smith', displayName: 'John Smith', primaryAddressFull: '5 Oak St, Brooklyn', statusLabel: 'Hot', phones: ['+12125550708'] })
    seed(w, { id: 'Lmary', seq: 2, name: 'Mary Smith', displayName: 'Mary Smith', primaryAddressFull: '5 Oak St, Brooklyn', statusLabel: 'Hot', phones: ['+12125550708'] })
    await run(w)
    expect(lead(w, 'Ljohn').statusLabel).toBe('Hot')
    expect(lead(w, 'Lmary').statusLabel).toBe('Cold') // same street, same person: a confirmed match
  })

  it("away from the same street another person's name is still a new lead: Alice never gets Bob's address or Mojo ID", async () => {
    const w = importWorld('Mojo,Name,Address,Phone,Status\nM_BOB,Bob Other,5 Oak St,212-555-0709,Cold\n')
    seed(w, { id: 'Lalice', name: 'Alice Owner', displayName: 'Alice Owner', statusLabel: 'Hot', phones: ['+12125550709'] })
    expect(await run(w, MOJO_NAME_ADDR_PHONE_STATUS)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(lead(w, 'Lalice')).toMatchObject({ name: 'Alice Owner', primaryAddressFull: null, mojoId: null, statusLabel: 'Hot' })
    expect(w.leads).toHaveLength(2)
  })

  it('another street with another name on the same phone: a new lead', async () => {
    const w = importWorld('Name,Address,Phone,Status\nBob Other,"9 Elm St, Brooklyn",212-555-0710,Cold\n')
    seed(w, { id: 'Lalice', name: 'Alice Owner', displayName: 'Alice Owner', primaryAddressFull: '5 Oak St, Brooklyn', statusLabel: 'Hot', phones: ['+12125550710'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(lead(w, 'Lalice')).toMatchObject({ statusLabel: 'Hot', primaryAddressFull: '5 Oak St, Brooklyn' })
    expect(w.leads).toHaveLength(2)
  })

  it('a row with no address and another name on the phone: a new lead', async () => {
    const w = importWorld('Name,Phone\nBob Other,212-555-0711\n')
    seed(w, { id: 'Lalice', name: 'Alice Owner', displayName: 'Alice Owner', primaryAddressFull: '5 Oak St, Brooklyn', phones: ['+12125550711'] })
    expect(await run(w, NAME_PHONE)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(w.leads).toHaveLength(2)
  })
})
