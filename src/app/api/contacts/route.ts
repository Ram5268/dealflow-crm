import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { canonicalPhones } from '@/lib/shared/phone'
import { LEAD_EDIT_ACTIVITY_TYPE } from '@/lib/core-data/leads/edit-text'
import { SAME_LEAD_ADDED_BY, numbersToPutOnDoNotContact, putOnDoNotContact, putOnDoNotContactLines } from '@/lib/core-data/leads/opt-out'

const phoneSchema = z.object({
  phone: z.string().min(1),
  type: z.string().default('mobile'),
  isPrimary: z.boolean().default(false),
})
const emailSchema = z.object({
  email: z.string().email(),
  type: z.string().default('work'),
  isPrimary: z.boolean().default(false),
})
const createContactSchema = z.object({
  leadId: z.string().min(1),
  displayName: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  timezone: z.string().optional(),
  phones: z.array(phoneSchema).default([]),
  emails: z.array(emailSchema).default([]),
})

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const leadId = req.nextUrl.searchParams.get('leadId') ?? undefined
  const take = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200)
  const contacts = await prisma.contact.findMany({
    where: { organizationId, ...(leadId ? { leadId } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take,
    include: { phones: true, emails: true, urls: true },
  })
  return json({ contacts }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, createContactSchema)
  const lead = await prisma.lead.findFirst({
    where: { id: body.leadId, organizationId },
    select: { id: true },
  })
  if (!lead) throw new HttpError(400, 'leadId does not reference an org lead')
  // Brief 41 (H13): phones are stored in canonical E.164 like the importer's,
  // so opt-out checks match them however they were typed.
  const phones = canonicalPhones(body.phones)
  if (!phones.ok) throw new HttpError(400, `"${phones.invalid}" is not a valid phone number`)
  // Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23): a
  // new contact's numbers on a lead that has a number on the Do not contact
  // list go on the list too, with the same reason, in the same transaction as
  // the contact, and the lead's timeline says so (last 4 digits only); a new
  // contact bringing a number on the list takes the lead's other numbers with
  // it [engineering precaution, review round 1]. The list exists because a
  // homeowner asked not to be contacted; this contacts no one.
  const contact = await prisma.$transaction(
    async (tx) => {
      const existing = phones.phones.length
        ? await tx.contactPhone.findMany({ where: { contact: { leadId: lead.id } }, select: { phone: true } })
        : []
      const created = await tx.contact.create({
        data: {
          organizationId,
          leadId: body.leadId,
          displayName: body.displayName,
          name: body.name,
          title: body.title,
          timezone: body.timezone,
          phones: { create: phones.phones },
          emails: { create: body.emails },
        },
        include: { phones: true, emails: true },
      })
      const follow = await numbersToPutOnDoNotContact(tx, organizationId, {
        existing: existing.map((p) => p.phone),
        adding: phones.phones.map((p) => p.phone),
      })
      if (follow) {
        await putOnDoNotContact(tx, organizationId, follow, SAME_LEAD_ADDED_BY.newContact)
        await tx.activity.create({
          data: {
            organizationId,
            leadId: lead.id,
            userId: null,
            contactId: null,
            type: LEAD_EDIT_ACTIVITY_TYPE, // a note about the record, never counted as contact (query-dsl TIMELINE_NOTE_TYPES)
            activityAt: new Date(),
            bodyText: putOnDoNotContactLines(follow, 'contact').join('\n'),
          },
        })
      }
      return created
    },
    { maxWait: 10_000, timeout: 30_000 }, // the Railway link is slow (as src/lib/core-data/leads/edit.ts)
  )
  return json({ contact }, correlationId, { status: 201 })
})
