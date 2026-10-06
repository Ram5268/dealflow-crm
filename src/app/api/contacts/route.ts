import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { canonicalPhones } from '@/lib/shared/phone'

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
  const contact = await prisma.contact.create({
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
  return json({ contact }, correlationId, { status: 201 })
})
