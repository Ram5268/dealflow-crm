import { randomUUID } from 'node:crypto'
import { prisma } from '../../prisma'
import {
  getCredential,
  getDecryptedAccessToken,
  getDecryptedRefreshToken,
  updateAccessToken,
} from '../oauth/store'
import { refreshAccessToken } from '../oauth/gmail'
import { GmailClient } from './gmail-client'

/**
 * Outbound email send (brief §3.5 + sent-mail dedup).
 *
 * The dedup trick: before calling Gmail, we mint a client-side RFC5322 Message-ID
 * and store `Message.providerMessageId = "gmail:<that-id>"`. Gmail preserves the
 * header, so when the Sent-folder copy later syncs back, `parse.ts` derives the
 * SAME providerMessageId from the Message-ID header and the @unique constraint
 * short-circuits the insert — no duplicate, no delete-and-swap, no race window
 * (the id is set before the send, not read back from the response). See
 * docs/agent-d-handoff.md.
 */

export function generateMessageId(uuid: string = randomUUID()): string {
  return `<crm-${uuid}@dealflow-crm.local>`
}

export interface RawMessageInput {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  bodyHtml?: string
  bodyText?: string
  messageId: string
}

/** Build an RFC5322 message (base64url) carrying the client-side Message-ID. */
export function buildRawMessage(input: RawMessageInput): string {
  const lines: string[] = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
  ]
  if (input.cc?.length) lines.push(`Cc: ${input.cc.join(', ')}`)
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.join(', ')}`)
  if (input.subject) lines.push(`Subject: ${input.subject}`)
  lines.push(`Message-ID: ${input.messageId}`)
  lines.push('MIME-Version: 1.0')

  const { bodyHtml: html, bodyText: text } = input
  if (html && text) {
    const boundary = `bnd_${input.messageId.replace(/[^\w]/g, '').slice(0, 24)}`
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '')
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', text)
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', '', html)
    lines.push(`--${boundary}--`)
  } else if (html) {
    lines.push('Content-Type: text/html; charset="UTF-8"', '', html)
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"', '', text ?? '')
  }

  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

export type RawSender = (rawBase64url: string) => Promise<void>

export interface SendEmailResult {
  status: 'sent'
  providerMessageId: string
}

/**
 * Send the given outbox email Message. Injectable `sender` + `now` for tests; in
 * prod it sends via a GmailClient (honoring GMAIL_MOCK_URL in isolation).
 */
export async function sendEmailMessage(
  messageId: string,
  injected: { sender?: RawSender; now?: Date } = {},
): Promise<SendEmailResult> {
  const msg = await prisma.message.findUnique({ where: { id: messageId } })
  if (!msg) throw new Error(`sendEmailMessage: message ${messageId} not found`)
  if (msg.channel !== 'email') {
    throw new Error(`sendEmailMessage: message ${messageId} is not an email`)
  }

  const cred = await getCredential(msg.organizationId, 'gmail')
  if (!cred) throw new Error('sendEmailMessage: no active Gmail credential for org')

  let accessToken = getDecryptedAccessToken(cred)
  const refreshToken = getDecryptedRefreshToken(cred)
  const expired = !cred.expiresAt || cred.expiresAt.getTime() < Date.now() + 60_000
  if (refreshToken && expired) {
    const refreshed = await refreshAccessToken(refreshToken)
    accessToken = refreshed.accessToken
    await updateAccessToken(cred.id, refreshed.accessToken, refreshed.expiresAt)
  }

  // Pre-set the dedup key inside a transaction, BEFORE sending.
  const headerId = generateMessageId()
  const providerMessageId = `gmail:${headerId}`
  await prisma.$transaction(async (tx) => {
    await tx.message.update({
      where: { id: messageId },
      data: { providerMessageId },
    })
  })

  const raw = buildRawMessage({
    from: cred.emailAddress ?? msg.fromAddress,
    to: msg.toAddresses,
    cc: msg.ccAddresses,
    bcc: msg.bccAddresses,
    subject: msg.subject ?? undefined,
    bodyHtml: msg.bodyHtml ?? undefined,
    bodyText: msg.bodyText ?? undefined,
    messageId: headerId,
  })

  const sender =
    injected.sender ??
    (async (r: string) => {
      const client = GmailClient.forAccessToken(accessToken, process.env.GMAIL_MOCK_URL)
      await client.sendRaw(r)
    })

  await sender(raw)

  await prisma.message.update({
    where: { id: messageId },
    data: { status: 'sent', dateSent: injected.now ?? new Date() },
  })
  return { status: 'sent', providerMessageId }
}
