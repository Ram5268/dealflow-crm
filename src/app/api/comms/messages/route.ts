import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { prisma } from '@/lib/prisma'
import { sendEmailMessage } from '@/lib/comms/email/send'
import { sendSmsMessage, ComplianceBlockedError } from '@/lib/comms/sms/send'
import { SmsDisabledError } from '@/lib/comms/sms/config'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

// Send an outgoing email or SMS (immediate or scheduled). SMS is gated by
// SMS_ENABLED + compliance scrub; email sends inline for immediate UX (sequence
// sends go through the tick + send worker).
export async function POST(req: Request) {
  const orgId = await getCurrentOrgId()
  const body = await req.json().catch(() => ({}))

  if (body.channel === 'sms') {
    try {
      const result = await sendSmsMessage({
        orgId,
        contactId: body.contactId,
        leadId: body.leadId,
        toPhone: body.toPhone ?? body.smsRemotePhone,
        contactPhoneId: body.contactPhoneId,
        body: body.bodyText,
      })
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof SmsDisabledError) {
        return NextResponse.json({ error: err.code }, { status: 503 })
      }
      if (err instanceof ComplianceBlockedError) {
        return NextResponse.json({ error: 'compliance_blocked', reasons: err.reasons }, { status: 409 })
      }
      logger.error({ err }, 'sms send failed')
      return NextResponse.json({ error: 'send_failed' }, { status: 500 })
    }
  }

  // Email.
  const scheduled = Boolean(body.scheduleAt)
  const msg = await prisma.message.create({
    data: {
      organizationId: orgId,
      contactId: body.contactId ?? null,
      leadId: body.leadId ?? null,
      channel: 'email',
      direction: 'outgoing',
      status: scheduled ? 'scheduled' : 'outbox',
      fromAddress: '',
      toAddresses: body.toAddresses ?? [],
      ccAddresses: body.ccAddresses ?? [],
      bccAddresses: body.bccAddresses ?? [],
      subject: body.subject ?? null,
      bodyHtml: body.bodyHtml ?? null,
      bodyText: body.bodyText ?? null,
      dateScheduled: scheduled ? new Date(body.scheduleAt) : null,
    },
  })

  if (scheduled) {
    return NextResponse.json({ messageId: msg.id, status: 'scheduled' })
  }

  try {
    const result = await sendEmailMessage(msg.id)
    return NextResponse.json({ messageId: msg.id, status: result.status })
  } catch (err) {
    logger.error({ err }, 'email send failed')
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: 'error', errorMessage: String(err) },
    })
    return NextResponse.json({ messageId: msg.id, status: 'error' }, { status: 502 })
  }
}
