import { prisma } from '@/lib/prisma'
import { recordMessageReceived } from '@/lib/core-data/activity/write'

// message.received (channel crm_message, emitter D). D writes the Message row
// (D-owned table) BEFORE emitting; A only READS it and appends an Activity that
// references it. Idempotent by messageId.
//
// Brief 50 (PR 3): the write itself lives in core-data/activity/write.ts,
// shared with the inbound SMS and email paths that save the Message row (that
// is what runs on Vercel; this LISTEN consumer only runs from the local
// scripts/boot-*.ts). Both take the same per-message lock, so running both
// never doubles a row.

export interface MessageReceivedPayload {
  messageId: string
  channel: string // 'email' | 'sms'
  contactId?: string | null
  leadId?: string | null
  correlationId: string
}

export async function onMessageReceived(p: Record<string, unknown>): Promise<void> {
  const payload = p as unknown as MessageReceivedPayload
  await recordMessageReceived(prisma, {
    messageId: payload.messageId,
    leadId: payload.leadId,
    contactId: payload.contactId,
  })
}
