import { randomUUID } from 'node:crypto'
import { prisma } from '../../prisma'
import {
  getDecryptedAccessToken,
  getDecryptedRefreshToken,
  updateAccessToken,
  type OAuthProvider,
} from '../oauth/store'
import { refreshAccessToken as gmailRefresh } from '../oauth/gmail'
import { refreshAccessToken as graphRefresh } from '../oauth/graph'
import { GmailClient } from './gmail-client'
import { GraphClient, type GraphSendMessage } from './graph-client'
import { emailEnabled, EmailDisabledError } from './config'

/**
 * Outbound email send (brief §3.5 + §M5 provider routing).
 *
 * Dedup lynchpin: before sending we mint a client-side id and store it as
 * `providerMessageId`. For Gmail it's the RFC5322 Message-ID header
 * (`gmail:<crm-…>`); for Graph it's the `internetMessageId` on the draft
 * (`msft:<crm-…>`). Either way, when the Sent copy syncs back, the parser derives
 * the SAME providerMessageId and the @unique constraint short-circuits the insert
 * — id set before send, no race window. See docs/agent-d-handoff.md.
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

/** Build an RFC5322 message (base64url) carrying the client-side Message-ID (Gmail). */
export function buildRawMessage(input: RawMessageInput): string {
  const lines: string[] = [`From: ${input.from}`, `To: ${input.to.join(', ')}`]
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

interface ResolvedCredential {
  provider: OAuthProvider
  credId: string
  emailAddress: string
  accessToken: string
}

/**
 * Pick the credential to send from: prefer one whose emailAddress matches the
 * message's fromAddress, else Gmail, else the first active. Refreshes a stale
 * access token via the provider-appropriate refresh.
 */
export async function resolveSendCredential(
  orgId: string,
  fromAddress?: string,
): Promise<ResolvedCredential> {
  const creds = await prisma.oAuthCredential.findMany({
    where: { organizationId: orgId, status: 'active' },
  })
  if (creds.length === 0) {
    throw new Error('sendEmailMessage: no active email credential for org')
  }
  const cred =
    (fromAddress && creds.find((c) => c.emailAddress === fromAddress)) ||
    creds.find((c) => c.provider === 'gmail') ||
    creds[0]

  let accessToken = getDecryptedAccessToken(cred)
  const refreshToken = getDecryptedRefreshToken(cred)
  const expired = !cred.expiresAt || cred.expiresAt.getTime() < Date.now() + 60_000
  if (refreshToken && expired) {
    const r = cred.provider === 'gmail' ? await gmailRefresh(refreshToken) : await graphRefresh(refreshToken)
    accessToken = r.accessToken
    await updateAccessToken(cred.id, r.accessToken, r.expiresAt)
  }

  return {
    provider: cred.provider as OAuthProvider,
    credId: cred.id,
    emailAddress: cred.emailAddress ?? fromAddress ?? '',
    accessToken,
  }
}

export interface SendArgs {
  provider: OAuthProvider
  accessToken: string
  headerId: string
  from: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any
}
export type ProviderSender = (args: SendArgs) => Promise<void>

async function defaultSend(args: SendArgs): Promise<void> {
  const { provider, accessToken, headerId, from, message } = args
  if (provider === 'gmail') {
    const raw = buildRawMessage({
      from,
      to: message.toAddresses,
      cc: message.ccAddresses,
      bcc: message.bccAddresses,
      subject: message.subject ?? undefined,
      bodyHtml: message.bodyHtml ?? undefined,
      bodyText: message.bodyText ?? undefined,
      messageId: headerId,
    })
    await GmailClient.forAccessToken(accessToken, process.env.GMAIL_MOCK_URL).sendRaw(raw)
    return
  }
  const graphMessage: GraphSendMessage = {
    internetMessageId: headerId,
    subject: message.subject ?? undefined,
    body: message.bodyHtml
      ? { contentType: 'HTML', content: message.bodyHtml }
      : { contentType: 'Text', content: message.bodyText ?? '' },
    toRecipients: (message.toAddresses ?? []).map((a: string) => ({ emailAddress: { address: a } })),
    ccRecipients: (message.ccAddresses ?? []).map((a: string) => ({ emailAddress: { address: a } })),
    bccRecipients: (message.bccAddresses ?? []).map((a: string) => ({ emailAddress: { address: a } })),
  }
  await new GraphClient(accessToken).createAndSend(graphMessage)
}

export interface SendEmailResult {
  status: 'sent'
  providerMessageId: string
}

export async function sendEmailMessage(
  messageId: string,
  injected: { send?: ProviderSender; now?: Date } = {},
): Promise<SendEmailResult> {
  // Brief 37: email is off during the test phase. Refuse before reading the
  // message, refreshing a token or calling Gmail/Graph.
  if (!emailEnabled()) throw new EmailDisabledError()

  const msg = await prisma.message.findUnique({ where: { id: messageId } })
  if (!msg) throw new Error(`sendEmailMessage: message ${messageId} not found`)
  if (msg.channel !== 'email') {
    throw new Error(`sendEmailMessage: message ${messageId} is not an email`)
  }

  const resolved = await resolveSendCredential(msg.organizationId, msg.fromAddress || undefined)

  const headerId = generateMessageId()
  const prefix = resolved.provider === 'gmail' ? 'gmail' : 'msft'
  const providerMessageId = `${prefix}:${headerId}`
  await prisma.$transaction(async (tx) => {
    await tx.message.update({ where: { id: messageId }, data: { providerMessageId } })
  })

  const send = injected.send ?? defaultSend
  await send({
    provider: resolved.provider,
    accessToken: resolved.accessToken,
    headerId,
    from: resolved.emailAddress || msg.fromAddress,
    message: msg,
  })

  await prisma.message.update({
    where: { id: messageId },
    data: { status: 'sent', dateSent: injected.now ?? new Date() },
  })
  return { status: 'sent', providerMessageId }
}
