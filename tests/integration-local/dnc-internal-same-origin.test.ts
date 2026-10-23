import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { POST } from '@/app/api/compliance/dnc/internal/route'
import { DO_NOT_CONTACT_ADDED_BY } from '@/lib/settings/doNotContact'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 (PR 16), engineering precaution (Brief 47's report, "found but not
// fixed"): the add route answers only the CRM's own pages. A cross-site page
// can't make Ryan's logged-in browser add an opt-out; the Settings form and a
// script that sends the password itself still can. Against a test database
// (made-up numbers in 555-0100 to 555-0199 only).
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN

const FORM_TYPED = '212-555-0164'
const FORM_STORED = '+12125550164'
const SCRIPT_STORED = '+12125550165'
const FORGED_STORED = '+12125550166'
const MINE = [FORM_STORED, SCRIPT_STORED, FORGED_STORED]

const ADDRESS = 'http://localhost/api/compliance/dnc/internal'

function post(body: string, headers: Record<string, string>) {
  return POST(new Request(ADDRESS, { method: 'POST', headers, body }))
}

describe.runIf(enabled)('dnc/internal: same-origin check, against the database', () => {
  let orgId: string
  let startCount: number
  const internalCount = () => prisma.dncSuppression.count({ where: { organizationId: orgId, source: 'internal' } })
  const rowsFor = (phone: string) => prisma.dncSuppression.findMany({ where: { organizationId: orgId, phone } })
  // Removes only this file's own made-up rows (test hygiene on a test
  // database); the route itself never removes an opt-out.
  const cleanUp = () => prisma.dncSuppression.deleteMany({ where: { organizationId: orgId, source: 'internal', phone: { in: MINE } } })

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    await cleanUp()
    startCount = await internalCount()
  })
  afterAll(async () => {
    await cleanUp()
  })

  it('a cross-site page posting JSON (fetch, no-cors) gets 403 and nothing is written', async () => {
    const res = await post(
      JSON.stringify({ phone: FORGED_STORED, reason: 'forged', addedBy: DO_NOT_CONTACT_ADDED_BY }),
      { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    )
    expect(res.status).toBe(403)
    expect(await rowsFor(FORGED_STORED)).toHaveLength(0)
    expect(await internalCount()).toBe(startCount)
  })

  it('an older browser (Origin only, no Sec-Fetch-Site) from another site gets 403 and nothing is written', async () => {
    const res = await post(JSON.stringify({ phone: FORGED_STORED }), {
      'content-type': 'application/json',
      origin: 'https://evil.example',
    })
    expect(res.status).toBe(403)
    expect(await rowsFor(FORGED_STORED)).toHaveLength(0)
    expect(await internalCount()).toBe(startCount)
  })

  it("the Settings form's same-origin request is added (201)", async () => {
    const res = await post(
      JSON.stringify({ phone: FORM_TYPED, reason: 'Asked on a call', addedBy: DO_NOT_CONTACT_ADDED_BY }),
      { 'content-type': 'application/json', origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ phone: FORM_STORED, source: 'internal', added: true })
    const rows = await rowsFor(FORM_STORED)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'internal', addedBy: DO_NOT_CONTACT_ADDED_BY, reason: 'Asked on a call' })
  })

  it('a script with no Origin (it sent the password itself) is added (201), stored as "user-request" when it names no addedBy', async () => {
    const res = await post(JSON.stringify({ phone: SCRIPT_STORED, reason: 'Asked by email' }), {
      'content-type': 'application/json',
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ phone: SCRIPT_STORED, added: true })
    expect(await rowsFor(SCRIPT_STORED)).toEqual([expect.objectContaining({ source: 'internal', addedBy: 'user-request' })])
  })

  it('only the two allowed adds were written, and no opt-out was removed', async () => {
    expect(await internalCount()).toBe(startCount + 2)
    expect(await rowsFor(FORGED_STORED)).toHaveLength(0)
  })
})
