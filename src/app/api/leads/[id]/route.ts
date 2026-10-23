import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'
import { hydrateCustomFields } from '@/lib/core-data/leads/serialize'
import { applyLeadEdit, parseLeadEdit } from '@/lib/core-data/leads/edit'
import { lockedMessage, lockedPhone } from '@/lib/core-data/leads/opt-out'

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

// Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23): a
// lead holding a number on the Do not contact list (as the call checks match
// it) or with texts blocked can't be deleted here, the same as the Edit form
// can't remove that number. The list exists because a homeowner asked not to
// be contacted.
export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const id = params!.id
  const existing = await prisma.lead.findFirst({
    where: { id, organizationId },
    select: { id: true, contacts: { select: { phones: { select: { phone: true, outboundSmsBlocked: true } } } } },
  })
  if (!existing) throw new HttpError(404, 'Lead not found')
  const locked = await lockedPhone(prisma, organizationId, existing.contacts.flatMap((c) => c.phones))
  if (locked) throw new HttpError(400, lockedMessage(locked, "this lead can't be deleted here."))
  await prisma.lead.delete({ where: { id } })
  return json({ deleted: true }, correlationId)
})
