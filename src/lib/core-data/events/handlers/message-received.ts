import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'

// message.received (channel crm_message, emitter D). D writes the Message row
// (D-owned table) BEFORE emitting; A only READS it and appends an Activity that
// references it. Idempotent by messageId.

export interface MessageReceivedPayload {
  messageId: string
  channel: string // 'email' | 'sms'
  contactId?: string | null
  leadId?: string | null
  correlationId: string
}

export async function onMessageReceived(p: Record<string, unknown>): Promise<void> {
  const payload = p as unknown as MessageReceivedPayload

  const existing = await prisma.activity.findFirst({
    where: { messageId: payload.messageId },
    select: { id: true },
  })
  if (existing) return // idempotent

  // Read D's Message row (A never writes this table).
  const message = await prisma.message.findUnique({ where: { id: payload.messageId } })
  if (!message) {
    logger.warn({ correlationId: payload.correlationId, messageId: payload.messageId }, 'message.received: Message row not found')
    return
  }

  const type = payload.channel === 'email' ? 'Email' : 'SMS'
  await prisma.activity.create({
    data: {
      organizationId: message.organizationId,
      leadId: payload.leadId ?? message.leadId ?? null,
      contactId: payload.contactId ?? message.contactId ?? null,
      type,
      messageId: message.id,
      activityAt: message.activityAt,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
    },
  })
}
