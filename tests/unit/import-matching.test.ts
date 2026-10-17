import { describe, it, expect } from 'vitest'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import { BATCH, col, emitOk, importWorld, mappingOf, type FakeLead } from './helpers/fake-import-db'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'

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
// A later import of a file into the same CRM (a fresh batch, the same leads).
const importAgain = (w: World, csv: string, mapping = NAME_ADDR_PHONE_STATUS) => {
  Object.assign(w.batch, {
    status: 'mapping_review', sourceBlob: Buffer.from(csv), errorLog: [], completedAt: null, mappingJson: null,
    totalRows: 0, importedRows: 0, duplicateRows: 0, skippedRows: 0, errorRows: 0,
  })
  return commitImport(BATCH, 'merge', mapping, 'c2', { db: w.db('run2'), emit: emitOk })
}
const lead = (w: World, id: string) => w.leads.find((l) => l.id === id)!

describe('another unit is another property (review item 1)', () => {
  it('a 5A row on the 4B lead\'s phone becomes its own lead; 4B keeps its status', async () => {
    const w = importWorld('Name,Address,Phone,Status\nDan Sample,"123 Main St 5A, Brooklyn, NY",212-555-0604,Cold\n')
    seed(w, { id: 'L4B', name: 'Dan Sample', displayName: 'Dan Sample', primaryAddressFull: '123 Main St 4B, Brooklyn, NY', statusLabel: 'Hot', phones: ['+12125550604'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(lead(w, 'L4B')).toMatchObject({ primaryAddressFull: '123 Main St 4B, Brooklyn, NY', statusLabel: 'Hot' })
    expect(w.leads).toHaveLength(2)
  })

  it("a B row on the A lead's phone becomes its own lead; A keeps its status", async () => {
    const w = importWorld('Name,Address,Phone,Status\nDan Sample,"123 Main St B, Brooklyn, NY",212-555-0614,Cold\n')
    seed(w, { id: 'LA', name: 'Dan Sample', displayName: 'Dan Sample', primaryAddressFull: '123 Main St A, Brooklyn, NY', statusLabel: 'Hot', phones: ['+12125550614'] })
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(lead(w, 'LA')).toMatchObject({ primaryAddressFull: '123 Main St A, Brooklyn, NY', statusLabel: 'Hot' })
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

describe('a name you kept is kept for good: later Mojo imports never replace it (re-review item 2, Ryan\'s decision)', () => {
  const LEE = 'Mojo,Name,Address,Phone,Status\nM_LEE,Lee Other,8 Birch Street,212-555-0505,Cold\n'
  const kim = (w: World) =>
    seed(w, { id: 'Lkim', name: 'Kim Owner', displayName: 'Kim Owner', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201', statusLabel: 'Hot', phones: ['+12125550505'] })

  it('the same Mojo file imported twice: still "Kim Owner", Hot, her address; the Mojo ID linked', async () => {
    const w = importWorld(LEE)
    kim(w)
    expect(await run(w, MOJO_NAME_ADDR_PHONE_STATUS)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Kim Owner', statusLabel: 'Hot', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201', mojoId: 'M_LEE' })
    // The second time it matches by Mojo ID; the names still conflict, so it only fills blanks.
    expect(await importAgain(w, LEE, MOJO_NAME_ADDR_PHONE_STATUS)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Kim Owner', displayName: 'Kim Owner', statusLabel: 'Hot', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201', mojoId: 'M_LEE' })
    expect(w.leads).toHaveLength(1)
  })

  it('the same Mojo row twice in one file: the second never renames her either', async () => {
    const w = importWorld(LEE + 'M_LEE,Lee Other,8 Birch Street,212-555-0505,Cold\n')
    kim(w)
    expect(await run(w, MOJO_NAME_ADDR_PHONE_STATUS)).toMatchObject({ totalRows: 2, importedRows: 2, duplicateRows: 2 })
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Kim Owner', statusLabel: 'Hot', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201', mojoId: 'M_LEE' })
    expect(w.leads).toHaveLength(1)
  })

  it('a Mojo ID match whose name agrees still updates the status and address', async () => {
    const w = importWorld('Mojo,Name,Address,Phone,Status\nM_KIM,KIM OWNER,"8 Birch St Apt 2, Brooklyn, NY 11201",212-555-0506,Cold\n')
    seed(w, { id: 'Lkim', name: 'Kim Owner', displayName: 'Kim Owner', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201', statusLabel: 'Hot', mojoId: 'M_KIM', phones: ['+12125550506'] })
    expect(await run(w, MOJO_NAME_ADDR_PHONE_STATUS)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'KIM OWNER', statusLabel: 'Cold', primaryAddressFull: '8 Birch St Apt 2, Brooklyn, NY 11201' })
  })

  it('a Mojo ID match on a lead with no real name updates it as before', async () => {
    const w = importWorld('Mojo,Name,Address,Phone,Status\nM_NEW,Nia Owner,"3 Ash St, Brooklyn",212-555-0507,Cold\n')
    seed(w, { id: 'Lph', displayName: 'Imported Lead', mojoId: 'M_NEW', statusLabel: 'Hot', phones: ['+12125550507'] })
    await run(w, MOJO_NAME_ADDR_PHONE_STATUS)
    expect(lead(w, 'Lph')).toMatchObject({ name: 'Nia Owner', displayName: 'Nia Owner', statusLabel: 'Cold', primaryAddressFull: '3 Ash St, Brooklyn' })
  })
})

describe("Mojo's property details still update on a Mojo ID match (round-3 item 2, Ryan's decision)", () => {
  const EST = { column: 'Est', sampleValues: [], target: { kind: 'existing_custom_field' as const, definitionId: 'cfd_est' }, confidence: 1, reasoning: '' }
  const MOJO_NAME_STATUS_EST = { mapping: [col('Mojo', 'Lead.mojoId'), col('Name', 'Lead.name'), col('Status', 'Lead.statusLabel'), EST], likelyDuplicates: [] } as unknown as MappingProposal
  const NAME_ADDR_PHONE_EST = { mapping: [col('Name', 'Lead.name'), col('Address', 'Lead.primaryAddressFull'), col('Phone', 'ContactPhone.phone'), EST], likelyDuplicates: [] } as unknown as MappingProposal
  const est = (w: World, leadId: string) => w.values.get(`cfd_est|${leadId}`)?.valueNumber
  const kimWithValue = (w: World, extra: Partial<FakeLead> = {}) => {
    w.fields.push({ id: 'cfd_est', name: 'Estimated Value', type: 'number' })
    seed(w, { id: 'Lkim', name: 'Kim Owner', displayName: 'Kim Owner', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201', statusLabel: 'Hot', mojoId: 'M_LEE', phones: ['+12125550505'], ...extra })
    w.values.set('cfd_est|Lkim', { definitionId: 'cfd_est', objectId: 'Lkim', valueNumber: 1500000 })
  }

  it('a later Mojo row with a new owner name and status: the name and status stay, the estimated value updates', async () => {
    const w = importWorld('Mojo,Name,Status,Est\nM_LEE,Raj Patel,Sold,1900000\n')
    kimWithValue(w)
    expect(await run(w, MOJO_NAME_STATUS_EST)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Kim Owner', displayName: 'Kim Owner', statusLabel: 'Hot', primaryAddressFull: '8 Birch St, Brooklyn, NY 11201' })
    expect(est(w, 'Lkim')).toBe(1900000)
  })

  it('another name at the same street with no Mojo ID only fills custom values, it never overwrites them', async () => {
    const w = importWorld('Name,Address,Phone,Est\nLee Other,8 Birch Street,212-555-0505,1900000\n')
    kimWithValue(w)
    expect(await run(w, NAME_ADDR_PHONE_EST)).toMatchObject({ importedRows: 1, duplicateRows: 1 })
    expect(est(w, 'Lkim')).toBe(1500000)
  })

  it('known limit: a Mojo export with the kept name as the Second Name agrees, so the lead updates to the main owner as before', async () => {
    const w = importWorld('Mojo,Name,Second,Status\nM_LEE,Raj Patel,Kim Owner,Sold\n')
    kimWithValue(w)
    await run(w, mappingOf(col('Mojo', 'Lead.mojoId'), col('Name', 'Lead.name'), col('Second', 'Contact.name'), col('Status', 'Lead.statusLabel')))
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Raj Patel', statusLabel: 'Sold' })
  })

  it("a Mojo owner who is already one of the lead's contacts agrees with it: it updates as before", async () => {
    const w = importWorld('Mojo,Name,Status\nM_LEE,Lee Owner,Sold\n')
    kimWithValue(w, { contacts: [{ id: 'c_kim', name: 'Kim Owner', displayName: 'Kim Owner' }, { id: 'c_lee', name: 'Lee Owner', displayName: 'Lee Owner' }] })
    await run(w, mappingOf(col('Mojo', 'Lead.mojoId'), col('Name', 'Lead.name'), col('Status', 'Lead.statusLabel')))
    expect(lead(w, 'Lkim')).toMatchObject({ name: 'Lee Owner', statusLabel: 'Sold' })
  })
})
