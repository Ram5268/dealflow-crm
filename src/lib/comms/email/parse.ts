/**
 * RFC 5322 envelope + Gmail payload parsing (brief §2.2 `parse.ts`).
 *
 * Pure helpers plus `parseGmailMessage`, which normalizes a Gmail
 * `users.messages.get` payload into a provider-neutral `ParsedEmail` the thread
 * reconstruction + persistence layers consume. No googleapis import — it takes a
 * structural `GmailMessageLike` that the real `Schema$Message` satisfies, so this
 * module stays unit-testable without the SDK.
 */

export interface ParsedEmail {
  providerMessageId: string // `gmail:<id>` — matches Message.providerMessageId
  providerThreadId: string // `gmail:<threadId>` — matches EmailThread.providerThreadId
  messageIdHeader?: string
  inReplyTo?: string
  references: string[]
  fromAddress: string
  toAddresses: string[]
  ccAddresses: string[]
  bccAddresses: string[]
  subject?: string
  date: Date
  bodyText?: string
  bodyHtml?: string
}

export interface GmailHeader {
  name?: string | null
  value?: string | null
}
export interface GmailPart {
  mimeType?: string | null
  filename?: string | null
  headers?: GmailHeader[] | null
  body?: { data?: string | null; size?: number | null } | null
  parts?: GmailPart[] | null
}
export interface GmailMessageLike {
  id?: string | null
  threadId?: string | null
  internalDate?: string | null
  payload?: GmailPart | null
}

/** All email addresses in a header value, `<bracketed>` preferred, lowercased + deduped. */
export function extractAddresses(headerValue?: string | null): string[] {
  if (!headerValue) return []
  const out: string[] = []
  const seen = new Set<string>()
  const re = /<([^<>]+@[^<>]+)>|([^\s<>,"]+@[^\s<>,"]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(headerValue)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim().toLowerCase()
    if (raw && !seen.has(raw)) {
      seen.add(raw)
      out.push(raw)
    }
  }
  return out
}

/** The first address in a header value, or "". */
export function firstAddress(headerValue?: string | null): string {
  return extractAddresses(headerValue)[0] ?? ''
}

/** Header list → lowercased-key map (first occurrence wins). */
export function headersToMap(headers?: GmailHeader[] | null): Record<string, string> {
  const map: Record<string, string> = {}
  for (const h of headers ?? []) {
    const name = h.name?.toLowerCase()
    if (name && h.value != null && !(name in map)) map[name] = h.value
  }
  return map
}

/** Decode a Gmail body part (`body.data` is base64url). */
export function decodeBody(data?: string | null): string {
  if (!data) return ''
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** Recursively collect the first text/plain + text/html parts. */
export function collectBodies(part?: GmailPart | null): { text?: string; html?: string } {
  const out: { text?: string; html?: string } = {}
  const walk = (p?: GmailPart | null): void => {
    if (!p) return
    const mime = p.mimeType ?? ''
    if (mime === 'text/plain' && p.body?.data && out.text === undefined) {
      out.text = decodeBody(p.body.data)
    } else if (mime === 'text/html' && p.body?.data && out.html === undefined) {
      out.html = decodeBody(p.body.data)
    }
    for (const child of p.parts ?? []) walk(child)
  }
  walk(part)
  return out
}

/** Normalize a Gmail message into a `ParsedEmail`. */
export function parseGmailMessage(msg: GmailMessageLike): ParsedEmail {
  const headers = headersToMap(msg.payload?.headers)
  const bodies = collectBodies(msg.payload)
  const id = msg.id ?? ''
  const threadId = msg.threadId ?? ''

  const date = msg.internalDate
    ? new Date(Number(msg.internalDate))
    : headers['date']
      ? new Date(headers['date'])
      : new Date(0)

  const references = (headers['references'] ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    providerMessageId: `gmail:${id}`,
    providerThreadId: `gmail:${threadId}`,
    messageIdHeader: headers['message-id'],
    inReplyTo: headers['in-reply-to'],
    references,
    fromAddress: firstAddress(headers['from']),
    toAddresses: extractAddresses(headers['to']),
    ccAddresses: extractAddresses(headers['cc']),
    bccAddresses: extractAddresses(headers['bcc']),
    subject: headers['subject'],
    date,
    bodyText: bodies.text,
    bodyHtml: bodies.html,
  }
}
