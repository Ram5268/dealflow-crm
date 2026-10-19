import { prisma } from '../../prisma'
import { logger } from '../../logger'
import { toE164 } from '../../shared/phone'
import { notifyMessageReceived } from '../events'
import { recordMessageReceivedSafely } from '../../core-data/activity/write'
import { classifyOptOut } from './opt-out'
import { handleStop } from './stop-handler'

/**
 * Inbound SMS handling (brief §M4). Records the message, emits `message.received`,
 * and — if the body is an opt-out keyword — fires the STOP → DNC path. STOP still
 * records the inbound message (audit) and still emits (it IS an inbound SMS).
 *
 * Brief 41 (H12): the message is saved first, exactly once per Twilio message
 * (a redelivery finds it by providerMessageId instead of failing or
 * duplicating), and the STOP write is in-process and throws on failure so the
 * webhook answers non-2xx.
 *
 * Brief 41.1 (F5): what counts as an opt-out is in ./opt-out.ts (normalized
 * text, the FCC's revocation words, and longer messages that contain one).
 *
 * Brief 50 (PR 3): after that, the lead's timeline entry (Activity) is written
 * here, because nothing on Vercel consumes `message.received`. It comes after
 * the STOP write, so it can never hold up or block an opt-out, and it never
 * throws [engineering precaution]. It is idempotent, so Twilio's redelivery
 * fills in one an earlier attempt missed.
 */

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
  const result = await recordAndHandleStop(input)
  await recordMessageReceivedSafely(prisma, { messageId: result.messageId })
  return result
}

async function recordAndHandleStop(input: InboundSms): Promise<InboundResult> {
  const optOut = classifyOptOut(input.body)
  const from = toE164(input.from) ?? input.from
  const providerMessageId = `twilio:${input.messageSid}`

  // 1. Record the message (once). A redelivery of the same message reuses it.
  const existing = await prisma.message.findUnique({ where: { providerMessageId }, select: { id: true } })
  let messageId = existing?.id ?? null
  if (!messageId) {
    const phoneMatch = await prisma.contactPhone.findFirst({
      where: { phone: from, contact: { organizationId: input.orgId } },
      select: { contactId: true, contact: { select: { leadId: true } } },
    })
    const contactId = phoneMatch?.contactId ?? null
    const leadId = phoneMatch?.contact?.leadId ?? null
    let created = true
    try {
      messageId = (
        await prisma.message.create({
          data: {
            organizationId: input.orgId,
            contactId,
            leadId,
            channel: 'sms',
            direction: 'incoming',
            status: 'inbox',
            fromAddress: from,
            toAddresses: [input.to],
            smsRemotePhone: from,
            smsLocalPhone: input.to,
            bodyText: input.body,
            providerMessageId,
          },
        })
      ).id
    } catch (err) {
      // A concurrent delivery of the same message saved it first.
      const raced = await prisma.message.findUnique({ where: { providerMessageId }, select: { id: true } })
      if (!raced) throw err
      messageId = raced.id
      created = false
    }
    if (created) {
      try {
        await notifyMessageReceived({
          messageId,
          channel: 'sms',
          contactId: contactId ?? undefined,
          leadId: leadId ?? undefined,
          correlationId: input.correlationId ?? 'sms-inbound',
        })
      } catch (err) {
        // The message is saved; a missed event must not fail (and redeliver) it.
        logger.error({ err, messageId }, 'sms inbound: message.received emit failed')
      }
    }
  }

  // 2. STOP → internal DNC. Legally required: a failure throws, so the webhook
  // answers non-2xx rather than losing the opt-out.
  // A sender that isn't a phone number (a short code or a name) can't be put
  // on the opt-out list, and failing here would only make Twilio retry.
  if (optOut && !toE164(input.from)) {
    logger.warn({ messageId, kind: optOut.kind }, 'sms inbound: opt-out wording from a sender that is not a phone number; nothing to add')
    return { action: 'message', messageId }
  }
  if (optOut) {
    // An opt-out phrase inside a longer message is logged apart from a plain
    // keyword, so it can be found for review (never the body or the number).
    if (optOut.kind === 'phrase') {
      logger.warn({ messageId, phrase: optOut.phrase }, 'sms inbound: opt-out phrase inside a longer message; added to the opt-out list')
    } else {
      logger.info({ messageId, keyword: optOut.phrase }, 'sms inbound: opt-out keyword')
    }
    await handleStop(input.orgId, from, optOut)
  }

  return { action: optOut ? 'stop' : 'message', messageId }
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
