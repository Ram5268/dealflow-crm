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

  // Thread-scoped replies — Agent E, planner-approved §13 amendment 2026-08-30.
  // Previously this route neither accepted nor set `threadId`, so every reply was
  // persisted as its own single-message thread and surfaced in the inbox as a
  // "Re: <same subject>" row sitting above the message it answered.
  //
  // Validation is deliberately scoped to `threadId` alone: this route has no Zod
  // schema (every other field is read straight off the body), and adding one
  // would change how those fields are handled — well beyond this amendment.
  let threadId: string | null = null
  if (body.threadId !== undefined && body.threadId !== null) {
    if (typeof body.threadId !== 'string' || body.threadId.length === 0) {
      return NextResponse.json({ error: 'threadId must be a non-empty string' }, { status: 400 })
    }
    // `Message.threadId` is a free-form string, not a foreign key, so an
    // unvalidated value would let a caller staple a message onto another org's
    // thread. A thread is "ours" if we own a message carrying that threadId, or
    // the lone message whose own id names the thread.
    const owned = await prisma.message.findFirst({
      where: { organizationId: orgId, OR: [{ threadId: body.threadId }, { id: body.threadId }] },
      select: { id: true },
    })
    if (!owned) {
      return NextResponse.json({ error: 'thread_not_found' }, { status: 404 })
    }
    threadId = body.threadId
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
      // null keeps the legacy behaviour: a brand-new thread for compose-new.
      threadId,
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
