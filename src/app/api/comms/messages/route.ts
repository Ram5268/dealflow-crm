import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { prisma } from '@/lib/prisma'
import { sendEmailMessage } from '@/lib/comms/email/send'
import { sendSmsMessage, ComplianceBlockedError } from '@/lib/comms/sms/send'
import { SmsDisabledError } from '@/lib/comms/sms/config'
import { emailEnabled } from '@/lib/comms/email/config'
import { GraphDisabledError } from '@/lib/comms/graph-switch'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * Request shape for an outgoing send.
 *
 * Every field used to be read straight off the parsed body. Two of those reads
 * were live bugs: `toAddresses` went into a Prisma `String[]` unvalidated (a
 * non-array threw a raw Prisma error as a 500, and on the scheduled branch only
 * after a malformed row had been written), and `new Date(body.scheduleAt)`
 * turned junk into `Invalid Date` — Prisma-rejected — while a plausible-but-
 * wrong value silently scheduled the send at the wrong time.
 *
 * Deliberately permissive where the route already was: unknown keys are
 * stripped rather than rejected, `channel` still defaults to email, and the
 * nullable ids stay nullish because ReplyDrawer sends `null` for a voicemail's
 * `threadId` and for an unlinked `leadId`/`contactId`.
 */
const sendMessageSchema = z.object({
  channel: z.enum(['email', 'sms']).default('email'),
  contactId: z.string().nullish(),
  leadId: z.string().nullish(),
  // SMS branch.
  toPhone: z.string().nullish(),
  smsRemotePhone: z.string().nullish(),
  contactPhoneId: z.string().nullish(),
  // Non-empty when present: the ownership check below assumes a real key.
  threadId: z.string().min(1).nullish(),
  toAddresses: z.array(z.string()).default([]),
  ccAddresses: z.array(z.string()).default([]),
  bccAddresses: z.array(z.string()).default([]),
  subject: z.string().nullish(),
  bodyHtml: z.string().nullish(),
  bodyText: z.string().nullish(),
  // Any format `Date` can parse, but it must actually parse — this is the check
  // that stops `Invalid Date` reaching Prisma.
  scheduleAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'scheduleAt must be a parseable date' })
    .nullish(),
})

// Send an outgoing email or SMS (immediate or scheduled). SMS is gated by
// SMS_ENABLED + compliance scrub; email sends inline for immediate UX (sequence
// sends go through the tick + send worker).
export async function POST(req: Request) {
  const orgId = await getCurrentOrgId()
  const raw = await req.json().catch(() => ({}))

  const parsed = sendMessageSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  const body = parsed.data

  if (body.channel === 'sms') {
    // `sendSmsMessage` requires both of these. The old untyped read could hand
    // it `undefined`, which reached `isCallable(undefined, …)` — a compliance
    // check against no phone number. Refuse at the edge instead.
    const toPhone = body.toPhone ?? body.smsRemotePhone
    if (!toPhone || !body.bodyText) {
      return NextResponse.json(
        { error: 'invalid_request', issues: [{ message: 'sms requires toPhone and bodyText' }] },
        { status: 400 },
      )
    }
    try {
      const result = await sendSmsMessage({
        orgId,
        contactId: body.contactId ?? undefined,
        leadId: body.leadId ?? undefined,
        toPhone,
        contactPhoneId: body.contactPhoneId ?? undefined,
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

  // Brief 37: email is off during the test phase. Refuse before saving anything,
  // so no message waits in the outbox (or a schedule) to go out later.
  if (!emailEnabled()) {
    return NextResponse.json(
      {
        error: 'email_disabled',
        message: 'Email is off during the test phase (EMAIL_ENABLED is not true). Nothing was sent or saved.',
      },
      { status: 403 },
    )
  }

  // Thread-scoped replies — Agent E, planner-approved §13 amendment 2026-08-30.
  // Previously this route neither accepted nor set `threadId`, so every reply was
  // persisted as its own single-message thread and surfaced in the inbox as a
  // "Re: <same subject>" row sitting above the message it answered.
  //
  // The SHAPE check now lives in the schema above; the ownership check below is
  // unchanged and still the thing that stops cross-org stapling.
  let threadId: string | null = null
  if (body.threadId !== undefined && body.threadId !== null) {
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
      toAddresses: body.toAddresses,
      ccAddresses: body.ccAddresses,
      bccAddresses: body.bccAddresses,
      subject: body.subject ?? null,
      bodyHtml: body.bodyHtml ?? null,
      bodyText: body.bodyText ?? null,
      dateScheduled: scheduled ? new Date(body.scheduleAt as string) : null,
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
    // Brief 41.2: the only mailbox is Outlook, which is paused (Ryan's
    // instruction). Say so plainly rather than a generic failure; nothing
    // reached Microsoft.
    if (err instanceof GraphDisabledError) {
      return NextResponse.json(
        { messageId: msg.id, status: 'error', error: err.code, message: err.message },
        { status: 403 },
      )
    }
    return NextResponse.json({ messageId: msg.id, status: 'error' }, { status: 502 })
  }
}
