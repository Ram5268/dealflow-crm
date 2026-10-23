import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { lockedMessage, lockedPhone } from '@/lib/core-data/leads/opt-out'

const updateContactSchema = z.object({
  displayName: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
})

async function requireContact(id: string, organizationId: string) {
  const c = await prisma.contact.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!c) throw new HttpError(404, 'Contact not found')
}

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const contact = await prisma.contact.findFirst({
    where: { id: params!.id, organizationId },
    include: { phones: true, emails: true, urls: true },
  })
  if (!contact) throw new HttpError(404, 'Contact not found')
  return json({ contact }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireContact(params!.id, organizationId)
  const body = await parseBody(req, updateContactSchema)
  const contact = await prisma.contact.update({ where: { id: params!.id }, data: body })
  return json({ contact }, correlationId)
})

// Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23): a
// contact holding a number on the Do not contact list (as the call checks match
// it) or with texts blocked can't be deleted here, the same as the Edit form
// can't remove that number (src/lib/core-data/leads/edit.ts). The list exists
// because a homeowner asked not to be contacted.
export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const contact = await prisma.contact.findFirst({
    where: { id: params!.id, organizationId },
    select: { id: true, phones: { select: { phone: true, outboundSmsBlocked: true } } },
  })
  if (!contact) throw new HttpError(404, 'Contact not found')
  const locked = await lockedPhone(prisma, organizationId, contact.phones)
  if (locked) throw new HttpError(400, lockedMessage(locked, "this contact can't be deleted here."))
  await prisma.contact.delete({ where: { id: contact.id } })
  return json({ deleted: true }, correlationId)
})
