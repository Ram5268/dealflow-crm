import { describe, it, expect } from 'vitest'
import { buildRowPlan, commitImport, resolveMapping, rowContacts } from '@/lib/core-data/importer/commit-worker'
import { BATCH, col, emitOk, importWorld, mappingOf, type FakeLead } from './helpers/fake-import-db'

// Brief 50 PR 6 (open item 6.7): a Mojo row names the main owner in "Full Name"
// (→ Lead.name) and the co-owner in "Second Name" (→ Contact.name). The import
// made ONE contact, named after the co-owner, and put every phone on the row on
// it, so the co-owner looked like the person to call. Now the main owner's
// contact holds the row's phones and emails, and the co-owner is kept as a
// second contact with a name only. Made-up people and 555-01xx numbers only.

const MOJO = mappingOf(
  col('Contact ID', 'Lead.mojoId'),
  col('Full Name', 'Lead.name'),
  col('Second Name', 'Contact.name'),
  col('Address', 'Lead.primaryAddressFull'),
  col('Phone 1', 'ContactPhone.phone'),
  col('Phone 2', 'ContactPhone.phone'),
  col('Email', 'ContactEmail.email'),
)
const resolved = resolveMapping(MOJO.mapping, [])
const plan = (row: Record<string, string>) => buildRowPlan(row, resolved)
const run = (w: ReturnType<typeof importWorld>) => commitImport(BATCH, 'merge', MOJO, 'c', { db: w.db('run'), emit: emitOk })
const HEADER = 'Contact ID,Full Name,Second Name,Address,Phone 1,Phone 2,Email\n'

describe('rowContacts: who the row is about', () => {
  it('a main owner and a different co-owner: the owner first (holding the phones), then the co-owner', () => {
    const contacts = rowContacts(plan({ 'Full Name': 'Test Owner One', 'Second Name': 'Test Partner One', 'Phone 1': '212-555-0141' }))
    expect(contacts).toEqual([
      { displayName: 'Test Owner One', name: 'Test Owner One', title: null },
      { displayName: 'Test Partner One', name: 'Test Partner One', title: null },
    ])
  })

  it('no Second Name: one contact, as before', () => {
    expect(rowContacts(plan({ 'Full Name': 'Test Owner Two', 'Phone 1': '212-555-0142' }))).toEqual([
      { displayName: 'Test Owner Two', name: null, title: null },
    ])
  })

  it('only a Second Name (no main owner): that person is the contact, as before', () => {
    expect(rowContacts(plan({ 'Second Name': 'Test Partner Three', 'Phone 1': '212-555-0143' }))).toEqual([
      { displayName: 'Test Partner Three', name: 'Test Partner Three', title: null },
    ])
  })

  it('the same person written twice ("OWNER, Test" and "Test Owner") is one contact, as before', () => {
    expect(rowContacts(plan({ 'Full Name': 'Test Owner Four', 'Second Name': 'OWNER FOUR, Test' }))).toHaveLength(1)
  })

  it('a stand-in for a name ("Current Resident") is not a co-owner', () => {
    expect(rowContacts(plan({ 'Full Name': 'Test Owner Five', 'Second Name': 'Current Resident' }))).toHaveLength(1)
  })
})

describe('a new lead from a co-owner row (end to end on the fake database)', () => {
  it("the owner's contact holds every phone and email on the row; the co-owner's holds none", async () => {
    const w = importWorld(HEADER + 'M_CO1,Test Owner One,Test Partner One,"100 Example St, Brooklyn, NY",212-555-0151,212-555-0152,owner.one@example.com\n')
    expect(await run(w)).toMatchObject({ importedRows: 1, duplicateRows: 0 })
    expect(w.leads).toHaveLength(1)
    const [lead] = w.leads as FakeLead[]
    expect(lead).toMatchObject({ name: 'Test Owner One', displayName: 'Test Owner One' })
    expect(lead.contacts.map((c) => ({ name: c.name, phones: c.phones }))).toEqual([
      { name: 'Test Owner One', phones: ['+12125550151', '+12125550152'] },
      { name: 'Test Partner One', phones: [] },
    ])
  })

  it('a row with no co-owner still makes exactly one contact with its phones', async () => {
    const w = importWorld(HEADER + 'M_CO2,Test Owner Two,,"102 Example St, Brooklyn, NY",212-555-0153,,\n')
    await run(w)
    expect(w.leads[0].contacts.map((c) => ({ displayName: c.displayName, phones: c.phones }))).toEqual([
      { displayName: 'Test Owner Two', phones: ['+12125550153'] },
    ])
  })

  it("a later import of the same Mojo row adds new phones to the owner's contact, never the co-owner's", async () => {
    const w = importWorld(HEADER + 'M_CO3,Test Owner Three,Test Partner Three,"103 Example St, Brooklyn, NY",212-555-0154,,\n')
    await run(w)
    Object.assign(w.batch, {
      status: 'mapping_review', errorLog: [], completedAt: null, mappingJson: null,
      sourceBlob: Buffer.from(HEADER + 'M_CO3,Test Owner Three,Test Partner Three,"103 Example St, Brooklyn, NY",212-555-0154,212-555-0155,\n'),
    })
    expect(await commitImport(BATCH, 'merge', MOJO, 'c2', { db: w.db('run2'), emit: emitOk })).toMatchObject({ duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(w.leads[0].contacts.map((c) => c.phones)).toEqual([['+12125550154', '+12125550155'], []])
  })

  it('a merge into a lead that has no contact yet makes the same two contacts', async () => {
    const w = importWorld(HEADER + 'M_CO4,Test Owner Four,Test Partner Four,"104 Example St, Brooklyn, NY",212-555-0156,,\n')
    w.leads.push({
      id: 'L_bare', seq: 0, by: 'seed', phones: [], name: null, displayName: 'Imported Lead',
      primaryAddressFull: null, mojoId: 'M_CO4', statusLabel: null, contacts: [],
    })
    expect(await run(w)).toMatchObject({ duplicateRows: 1 })
    expect(w.leads).toHaveLength(1)
    expect(w.leads[0].contacts.map((c) => ({ name: c.name, phones: c.phones }))).toEqual([
      { name: 'Test Owner Four', phones: ['+12125550156'] },
      { name: 'Test Partner Four', phones: [] },
    ])
  })
})
