import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'
import { hydrateCustomFields } from '@/lib/core-data/leads/serialize'
import { applyLeadEdit, parseLeadEdit } from '@/lib/core-data/leads/edit'

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const id = params!.id
  const lead = await prisma.lead.findFirst({
    where: { id, organizationId },
    include: {
      contacts: { include: { phones: true, emails: true, urls: true } },
      opportunities: true,
      tasks: true,
    },
  })
  if (!lead) throw new HttpError(404, 'Lead not found')
  const customFields = await hydrateCustomFields(id)
  return json({ ...lead, customFields }, correlationId)
})

// Brief 50 PR 5: the lead page's Edit mode. Only the name, status, address
// and each contact's phones and emails; DealFlow's values are refused; one
// timeline entry per save that changes something (src/lib/core-data/leads/edit.ts).
export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new HttpError(400, "The changes couldn't be read. Reload the page and try again.")
  }
  const { lead, changes } = await applyLeadEdit(prisma, organizationId, params!.id, parseLeadEdit(raw))
  return json({ lead, changes }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const id = params!.id
  const existing = await prisma.lead.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!existing) throw new HttpError(404, 'Lead not found')
  await prisma.lead.delete({ where: { id } })
  return json({ deleted: true }, correlationId)
})
