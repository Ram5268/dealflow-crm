import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'

// call.connected (channel crm_call, emitter B). Appends an in-progress Call
// Activity and hydrates ammunition for the SSE bridge. Idempotent: a repeated
// emission for the same callId does not create a second Activity row.

export interface CallConnectedPayload {
  callId: string
  dialSessionId: string
  leadId: string | null
  contactId: string | null
  remotePhone: string
  connectedAt: string
  correlationId: string
}

export async function onCallConnected(p: Record<string, unknown>): Promise<void> {
  const payload = p as unknown as CallConnectedPayload
  const existing = await prisma.activity.findFirst({
    where: { callId: payload.callId, type: 'Call' },
    select: { id: true },
  })
  if (existing) return // idempotent

  // Resolve org from the lead when present (Activity requires organizationId).
  let organizationId: string | null = null
  if (payload.leadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: payload.leadId },
      select: { organizationId: true },
    })
    organizationId = lead?.organizationId ?? null
  }
  if (!organizationId) {
    // No resolvable org — record nothing rather than fabricate tenancy.
    logger.warn({ correlationId: payload.correlationId, callId: payload.callId }, 'call.connected: unresolved org')
    return
  }

  await prisma.activity.create({
    data: {
      organizationId,
      leadId: payload.leadId,
      contactId: payload.contactId,
      type: 'Call',
      callId: payload.callId,
      activityAt: new Date(payload.connectedAt),
      bodyText: 'Call in progress',
    },
  })
}
