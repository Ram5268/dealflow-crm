import { prisma } from '../../prisma'
import { notifyMessageReceived } from '../events'
import { handleStop } from './stop-handler'

/**
 * Inbound SMS handling (brief §M4). Records the message, emits `message.received`,
 * and — if the body is an opt-out keyword — fires the STOP → DNC path. STOP still
 * records the inbound message (audit) and still emits (it IS an inbound SMS).
 */
const STOP_RE = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i

export interface InboundSms {
  orgId: string
  from: string // E.164 remote phone
  to: string // our number
  body: string
  messageSid: string
  correlationId?: string
}

export interface InboundResult {
  action: 'stop' | 'message'
  messageId: string
}

export async function handleInboundSms(input: InboundSms): Promise<InboundResult> {
  const isStop = STOP_RE.test(input.body.trim())

  if (isStop) {
    // Legally-required cross-slice write; failure surfaces to the caller so it can
    // enqueue the sms-stop-relay retry.
    await handleStop(input.from, input.correlationId)
  }

  const phoneMatch = await prisma.contactPhone.findFirst({
    where: { phone: input.from, contact: { organizationId: input.orgId } },
    select: { contactId: true, contact: { select: { leadId: true } } },
  })
  const contactId = phoneMatch?.contactId ?? null
  const leadId = phoneMatch?.contact?.leadId ?? null

  const msg = await prisma.message.create({
    data: {
      organizationId: input.orgId,
      contactId,
      leadId,
      channel: 'sms',
      direction: 'incoming',
      status: 'inbox',
      fromAddress: input.from,
      toAddresses: [input.to],
      smsRemotePhone: input.from,
      smsLocalPhone: input.to,
      bodyText: input.body,
      providerMessageId: `twilio:${input.messageSid}`,
    },
  })

  await notifyMessageReceived({
    messageId: msg.id,
    channel: 'sms',
    contactId: contactId ?? undefined,
    leadId: leadId ?? undefined,
    correlationId: input.correlationId ?? 'sms-inbound',
  })

  return { action: isStop ? 'stop' : 'message', messageId: msg.id }
}

/**
 * Twilio delivery-status callback (brief §M4, B.3 option b). Raw Twilio state goes
 * to `providerDeliveryState`; `Message.status` only moves to `error` on a terminal
 * failure (undelivered|failed) — it stays coarse otherwise.
 */
export async function updateDeliveryState(
  twilioSid: string,
  deliveryState: string,
): Promise<void> {
  const terminalFailure = /^(undelivered|failed)$/i.test(deliveryState)
  await prisma.message.updateMany({
    where: { providerMessageId: `twilio:${twilioSid}` },
    data: {
      providerDeliveryState: deliveryState,
      ...(terminalFailure ? { status: 'error' } : {}),
    },
  })
}
