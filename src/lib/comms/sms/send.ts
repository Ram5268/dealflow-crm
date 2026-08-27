import { prisma } from '../../prisma'
import { smsEnabled, SmsDisabledError, requireTwilioConfig } from './config'
import { isCallable } from '../clients/compliance'
import { sendSms, type SendSmsInput } from './twilio-client'
import type { TwilioConfig } from './config'

/**
 * Outbound SMS send (brief §M4). Gated three ways before anything hits Twilio:
 *  1. SMS_ENABLED — else SmsDisabledError (never touches Twilio while parked).
 *  2. requireTwilioConfig — fail-fast if enabled but 10DLC SIDs are missing.
 *  3. compliance scrub (fail-closed) — not callable → ComplianceBlockedError.
 */
export class ComplianceBlockedError extends Error {
  readonly code = 'compliance_blocked'
  constructor(readonly reasons: string[]) {
    super(`SMS blocked by compliance: ${reasons.join(', ')}`)
    this.name = 'ComplianceBlockedError'
  }
}

export interface SendSmsMessageInput {
  orgId: string
  contactId?: string
  leadId?: string
  toPhone: string
  contactPhoneId?: string
  body: string
  correlationId?: string
}

type Sender = (input: SendSmsInput, cfg: TwilioConfig) => Promise<{ sid: string; status: string }>

export async function sendSmsMessage(
  input: SendSmsMessageInput,
  injected: { sender?: Sender } = {},
): Promise<{ messageId: string; status: string }> {
  if (!smsEnabled()) throw new SmsDisabledError()
  const cfg = requireTwilioConfig()

  const scrub = await isCallable(input.toPhone, {
    contactPhoneId: input.contactPhoneId,
    correlationId: input.correlationId,
  })
  if (!scrub.callable) throw new ComplianceBlockedError(scrub.reasons)

  const msg = await prisma.message.create({
    data: {
      organizationId: input.orgId,
      contactId: input.contactId ?? null,
      leadId: input.leadId ?? null,
      channel: 'sms',
      direction: 'outgoing',
      status: 'outbox',
      fromAddress: cfg.messagingServiceSid,
      smsRemotePhone: input.toPhone,
      smsLocalPhone: cfg.messagingServiceSid,
      bodyText: input.body,
    },
  })

  const send = injected.sender ?? sendSms
  try {
    const r = await send({ to: input.toPhone, body: input.body }, cfg)
    await prisma.message.update({
      where: { id: msg.id },
      data: {
        status: 'sent',
        providerMessageId: `twilio:${r.sid}`,
        providerDeliveryState: r.status,
        dateSent: new Date(),
      },
    })
    return { messageId: msg.id, status: 'sent' }
  } catch (err) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: 'error', errorMessage: String(err) },
    })
    throw err
  }
}
