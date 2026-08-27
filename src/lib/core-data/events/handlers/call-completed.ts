import { prisma } from '@/lib/prisma'

// call.completed (channel crm_call, emitter B). Updates the Call Activity with
// disposition + duration + cost. `cost` is a decimal-as-string and is stored
// VERBATIM in the Activity body metadata — never Number(cost) at ingest.

export interface CallCompletedPayload {
  callId: string
  disposition: string
  duration: number | null
  cost: string | null
  outcomeId?: string | null
  correlationId: string
}

function bodyFor(payload: CallCompletedPayload): string {
  // Store cost as the received string inside a small JSON metadata blob.
  const meta = {
    disposition: payload.disposition,
    duration: payload.duration,
    cost: payload.cost, // string | null — NOT coerced
    outcomeId: payload.outcomeId ?? null,
  }
  return `Call ${payload.disposition} ${JSON.stringify(meta)}`
}

export async function onCallCompleted(p: Record<string, unknown>): Promise<void> {
  const payload = p as unknown as CallCompletedPayload
  const existing = await prisma.activity.findFirst({
    where: { callId: payload.callId, type: 'Call' },
    select: { id: true },
  })

  if (existing) {
    await prisma.activity.update({
      where: { id: existing.id },
      data: { bodyText: bodyFor(payload) },
    })
    return
  }

  // call.completed arrived before call.connected (should not happen) — insert.
  await prisma.activity.create({
    data: {
      // Org unknown without a lead join here; a completed-before-connected event
      // carries no leadId. Skip if we cannot resolve tenancy.
      organizationId: (await firstOrgId()) ?? 'unknown',
      type: 'Call',
      callId: payload.callId,
      activityAt: new Date(),
      bodyText: bodyFor(payload),
    },
  })
}

async function firstOrgId(): Promise<string | null> {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  return org?.id ?? null
}
