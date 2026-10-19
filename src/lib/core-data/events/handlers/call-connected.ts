import { prisma } from '@/lib/prisma'
import { recordCallConnected } from '@/lib/core-data/activity/write'

// call.connected (channel crm_call, emitter B). Appends an in-progress Call
// Activity. Idempotent: a repeated emission for the same callId does not create
// a second Activity row.
//
// Brief 50 (PR 3): the write itself lives in core-data/activity/write.ts,
// shared with the code that writes the Call row (which is what runs on Vercel;
// this LISTEN consumer only runs from the local scripts/boot-*.ts). Both paths
// take the same per-call lock, so running both never doubles a row.

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
  await recordCallConnected(prisma, {
    callId: payload.callId,
    connectedAt: new Date(payload.connectedAt),
    leadId: payload.leadId,
    contactId: payload.contactId,
  })
}
