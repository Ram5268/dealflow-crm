import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { prisma } from '@/lib/prisma'
import { POST } from '@/app/api/compliance/dnc/internal/route'
import {
  DO_NOT_CONTACT_ADDED_BY,
  readDoNotContactList,
  type DoNotContactDb,
} from '@/lib/settings/doNotContact'
import { DoNotContactView } from '@/app/settings/do-not-contact/DoNotContactView'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 47 (PR 5): what Settings → Do not contact sends, through the existing
// route (unchanged) into a test database, and what the screen then reads back.
// Fictional numbers only (555-0100 to 555-0199).
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN

const TYPED = '212-555-0187'
const STORED = '+12125550187'
const FULL_FORMS = ['2125550187', '212-555-0187', '555-0187', '5550187']

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/compliance/dnc/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

describe.runIf(enabled)('Do not contact: the add route and the list', () => {
  let orgId: string
  const internalCount = () => prisma.dncSuppression.count({ where: { organizationId: orgId, source: 'internal' } })
  const cleanUp = () => prisma.dncSuppression.deleteMany({ where: { organizationId: orgId, phone: STORED, source: 'internal' } })

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    await cleanUp()
  })
  afterAll(async () => {
    await cleanUp()
  })

  it('a bad number is refused with 400 and nothing is written', async () => {
    const before = await internalCount()
    for (const phone of ['call me maybe', '12345']) {
      const res = await post({ phone, reason: 'test', addedBy: DO_NOT_CONTACT_ADDED_BY })
      expect(res.status, phone).toBe(400)
      expect(await res.json()).toEqual({ error: 'phone is not a valid phone number' })
    }
    expect(await internalCount()).toBe(before)
  })

  it("the form's request adds the number once (201 added:true, then added:false)", async () => {
    const first = await post({ phone: TYPED, reason: 'Asked on a call', addedBy: DO_NOT_CONTACT_ADDED_BY })
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ phone: STORED, source: 'internal', added: true })
    const again = await post({ phone: TYPED, addedBy: DO_NOT_CONTACT_ADDED_BY })
    expect(again.status).toBe(201)
    expect(await again.json()).toMatchObject({ phone: STORED, added: false })

    const rows = await prisma.dncSuppression.findMany({ where: { organizationId: orgId, phone: STORED } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'internal', addedBy: DO_NOT_CONTACT_ADDED_BY, reason: 'Asked on a call' })
  })

  it('the list shows it as its last 4 digits only; the full number is not in the page', async () => {
    const list = await readDoNotContactList(prisma as unknown as DoNotContactDb, orgId)
    expect(list.rows).toContainEqual(expect.objectContaining({ last4: '0187', reason: 'Asked on a call' }))
    expect(list.total).toBe(await internalCount())

    const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
    const html = renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, h(DoNotContactView, { list })))
    expect(html).toContain('•••• 0187')
    for (const payload of [html, JSON.stringify(list)]) {
      for (const form of FULL_FORMS) expect(payload).not.toContain(form)
    }
  })
})
