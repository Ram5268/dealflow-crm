import 'dotenv/config'
import { describe, it, expect, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { GET as listLeads, POST as createLead } from '@/app/api/leads/route'
import { GET as getLead, PUT as updateLead, DELETE as deleteLead } from '@/app/api/leads/[id]/route'
import { POST as createDef } from '@/app/api/custom-fields/route'
import { PUT as putValues } from '@/app/api/leads/[id]/custom-values/route'
import { POST as postActivity } from '@/app/api/activities/route'
import { mainIsTestDb } from '../setup/live-guard'

const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN

function req(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
}

describe.runIf(enabled)('leads CRUD + custom fields', () => {
  const createdLeadIds: string[] = []
  const createdDefIds: string[] = []

  afterAll(async () => {
    await prisma.customFieldValue.deleteMany({ where: { objectId: { in: createdLeadIds } } })
    await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } })
    await prisma.customFieldDefinition.deleteMany({ where: { id: { in: createdDefIds } } })
  })

  it('create → detail → list → update → delete', async () => {
    // Create
    const created = await createLead(
      req('/api/leads', { method: 'POST', body: { displayName: 'TEST_CRUD Lead', statusLabel: 'Hot' } })
    )
    expect(created.status).toBe(201)
    const { lead } = await created.json()
    expect(lead.displayName).toBe('TEST_CRUD Lead')
    createdLeadIds.push(lead.id)

    // Detail (customFields empty)
    const detail = await getLead(req(`/api/leads/${lead.id}`), { params: Promise.resolve({ id: lead.id }) })
    expect(detail.status).toBe(200)
    const detailBody = await detail.json()
    expect(detailBody.id).toBe(lead.id)
    expect(detailBody.customFields).toEqual([])

    // List includes it
    const list = await listLeads(req('/api/leads?limit=200'))
    const listBody = await list.json()
    expect(listBody.leads.some((l: { id: string }) => l.id === lead.id)).toBe(true)

    // Update
    const updated = await updateLead(
      req(`/api/leads/${lead.id}`, { method: 'PUT', body: { statusLabel: 'Warm' } }),
      { params: Promise.resolve({ id: lead.id }) }
    )
    const updatedBody = await updated.json()
    expect(updatedBody.lead.statusLabel).toBe('Warm')

    // Delete
    const del = await deleteLead(req(`/api/leads/${lead.id}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: lead.id }),
    })
    expect(del.status).toBe(200)
    const gone = await getLead(req(`/api/leads/${lead.id}`), { params: Promise.resolve({ id: lead.id }) })
    expect(gone.status).toBe(404)
    createdLeadIds.pop()
  })

  it('detail hides null-valued custom fields, shows populated ones', async () => {
    const lead = await prisma.lead.create({
      data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, displayName: 'TEST_CF Lead' },
    })
    createdLeadIds.push(lead.id)

    // Two definitions; only one gets a value.
    const d1 = await createDef(
      req('/api/custom-fields', { method: 'POST', body: { name: 'TEST_CF Price', type: 'number' } })
    )
    const def1 = (await d1.json()).definition
    createdDefIds.push(def1.id)
    const d2 = await createDef(
      req('/api/custom-fields', { method: 'POST', body: { name: 'TEST_CF Notes', type: 'text' } })
    )
    const def2 = (await d2.json()).definition
    createdDefIds.push(def2.id)

    // Set only def1
    await putValues(
      req(`/api/leads/${lead.id}/custom-values`, {
        method: 'PUT',
        body: { values: [{ definitionId: def1.id, value: 2500000 }] },
      }),
      { params: Promise.resolve({ id: lead.id }) }
    )

    const detail = await getLead(req(`/api/leads/${lead.id}`), { params: Promise.resolve({ id: lead.id }) })
    const body = await detail.json()
    expect(body.customFields).toHaveLength(1)
    expect(body.customFields[0].definitionId).toBe(def1.id)
    expect(body.customFields[0].value).toBe(2500000)
  })

  it('activities POST returns 405 (append-only)', async () => {
    const res = await postActivity(req('/api/activities', { method: 'POST', body: {} }))
    expect(res.status).toBe(405)
  })
})
