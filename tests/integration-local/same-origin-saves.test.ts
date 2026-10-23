import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PUT as updateLead } from '@/app/api/leads/[id]/route'
import { POST as confirmPolicy } from '@/app/api/compliance/policy/confirm/route'
import { POST as createList } from '@/app/api/core-data/lists/route'
import { POST as addListMembers } from '@/app/api/core-data/lists/[id]/members/route'
import { mainIsTestDb } from '../setup/live-guard'
import { throughMiddleware } from '../helpers/through-middleware'

// Brief 50 (PR 18), engineering precaution (the planner's review, Brief 50
// Revision 2, 2026-10-23): every save answers only the CRM's own pages. Each
// request here goes through the real middleware first (the password wall, then
// the same-origin check), then the route, as Next serves it. A page on another
// website gets 403 and nothing is written; the CRM's own pages save as before.
// Against a test database; made-up people and values only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `B50PR18_${Date.now().toString(36)}`
const CRM = 'http://localhost'

// What another website's page sends: a no-cors fetch or a `text/plain` form
// carrying a JSON body (it needs no CORS permission), with the browser's own
// Origin and Sec-Fetch-Site. The browser would add the saved login by itself.
const FROM_ANOTHER_SITE = { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
// What the CRM's own pages send (a relative fetch from the CRM).
const FROM_THE_CRM = { 'content-type': 'application/json', origin: CRM, 'sec-fetch-site': 'same-origin' }

// A timezone no other test or seed confirms, so its row is this file's alone.
const MADE_UP_TZ = 'Pacific/Chatham'

function req(method: string, pathname: string, body: unknown, headers: Record<string, string>) {
  return new NextRequest(new URL(pathname, CRM), { method, headers, body: JSON.stringify(body) })
}

describe.runIf(enabled)('every save refuses other websites (through the middleware, against the database)', () => {
  let orgId: string
  let leadId: string
  let listId: string

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    await prisma.callingWindowConfig.deleteMany({ where: { organizationId: orgId, timezone: MADE_UP_TZ } })
    leadId = (
      await prisma.lead.create({
        data: { organizationId: orgId, displayName: 'Test Owner 18', name: 'Test Owner 18', source: TAG },
      })
    ).id
  })

  afterAll(async () => {
    await prisma.activity.deleteMany({ where: { leadId } })
    await prisma.callList.deleteMany({ where: { organizationId: orgId, name: { startsWith: TAG } } })
    await prisma.lead.deleteMany({ where: { source: TAG } })
    await prisma.callingWindowConfig.deleteMany({ where: { organizationId: orgId, timezone: MADE_UP_TZ } })
  })

  beforeEach(() => {
    // The wall off (local dev): these tests isolate the same-origin check.
    vi.stubEnv('BASIC_AUTH_PASSWORD', undefined)
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.stubEnv('NODE_ENV', 'test')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const editLead = (headers: Record<string, string>, displayName: string) =>
    throughMiddleware(req('PUT', `/api/leads/${leadId}`, { displayName }, headers), (r) =>
      updateLead(r, { params: Promise.resolve({ id: leadId }) }),
    )

  it("editing a lead: another website's page gets 403 and the lead is unchanged", async () => {
    const { response, reachedRoute } = await editLead(FROM_ANOTHER_SITE, 'Renamed By Another Site')
    expect(response.status).toBe(403)
    expect(reachedRoute).toBe(false)
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })
    expect(lead.displayName).toBe('Test Owner 18')
    expect(await prisma.activity.count({ where: { leadId } })).toBe(0)
  })

  it('editing a lead: a script with no Origin gets 403 too', async () => {
    const { response } = await editLead({ 'content-type': 'application/json' }, 'Renamed By A Script')
    expect(response.status).toBe(403)
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).displayName).toBe('Test Owner 18')
  })

  it("editing a lead: the CRM's own page saves (200)", async () => {
    const { response, reachedRoute } = await editLead(FROM_THE_CRM, 'Test Owner 18 Renamed')
    expect(reachedRoute).toBe(true)
    expect(response.status).toBe(200)
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).displayName).toBe('Test Owner 18 Renamed')
  })

  const policy = {
    timezone: MADE_UP_TZ,
    earliestHour: 9,
    latestHour: 20,
    allowedDaysOfWeek: [1, 2, 3, 4, 5],
    policyConfirmedBy: 'user:made-up|counsel:made-up|date:2026-10-23',
  }

  it("confirming calling hours (a calling gate): another website's page gets 403 and nothing is confirmed", async () => {
    const { response, reachedRoute } = await throughMiddleware(
      req('POST', '/api/compliance/policy/confirm', policy, FROM_ANOTHER_SITE),
      (r) => confirmPolicy(r),
    )
    expect(response.status).toBe(403)
    expect(reachedRoute).toBe(false)
    expect(await prisma.callingWindowConfig.count({ where: { organizationId: orgId, timezone: MADE_UP_TZ } })).toBe(0)
  })

  it("confirming calling hours: Safari re-sending another website's refused form on Back (same-origin, the other site's or a null Origin) gets 403 and nothing is confirmed", async () => {
    // WebKit re-sends a refused POST on a history navigation with
    // Sec-Fetch-Site `same-origin` but the original Origin (seen in
    // Playwright's WebKit, Brief 50 PR 18 review); the Origin decides.
    for (const origin of ['https://evil.example', 'null']) {
      const { response, reachedRoute } = await throughMiddleware(
        req('POST', '/api/compliance/policy/confirm', policy, { 'content-type': 'text/plain', origin, 'sec-fetch-site': 'same-origin' }),
        (r) => confirmPolicy(r),
      )
      expect(response.status).toBe(403)
      expect(reachedRoute).toBe(false)
    }
    expect(await prisma.callingWindowConfig.count({ where: { organizationId: orgId, timezone: MADE_UP_TZ } })).toBe(0)
  })

  it("confirming calling hours: the CRM's own page reaches the route (its own 400 for an incomplete form; no gate opened here)", async () => {
    const { response, reachedRoute } = await throughMiddleware(
      req('POST', '/api/compliance/policy/confirm', { timezone: MADE_UP_TZ }, FROM_THE_CRM),
      (r) => confirmPolicy(r),
    )
    expect(reachedRoute).toBe(true)
    expect(response.status).toBe(400)
    expect(await prisma.callingWindowConfig.count({ where: { organizationId: orgId, timezone: MADE_UP_TZ } })).toBe(0)
  })

  it("lists: the CRM's own page makes a list and adds someone; another website can't add anyone", async () => {
    const made = await throughMiddleware(req('POST', '/api/core-data/lists', { name: `${TAG} List` }, FROM_THE_CRM), (r) => createList(r))
    expect(made.response.status).toBe(201)
    listId = ((await made.response.json()) as { list: { id: string } }).list.id

    const members = (headers: Record<string, string>) =>
      throughMiddleware(req('POST', `/api/core-data/lists/${listId}/members`, { leadIds: [leadId] }, headers), (r) =>
        addListMembers(r, { params: Promise.resolve({ id: listId }) }),
      )

    const forged = await members(FROM_ANOTHER_SITE)
    expect(forged.response.status).toBe(403)
    expect(await prisma.listMembership.count({ where: { listId } })).toBe(0)

    const mine = await members(FROM_THE_CRM)
    expect(mine.response.status).toBe(200)
    expect(await prisma.listMembership.count({ where: { listId } })).toBe(1)
  })
})
