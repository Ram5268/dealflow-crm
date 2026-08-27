import type { ParsedEmail } from './parse'

/**
 * Microsoft Graph mail client (brief §M5) via REST/fetch — same mockable pattern
 * as the Twilio client. Base URL is env-overridable (GRAPH_MOCK_URL) so isolation
 * points it at the Graph mock. Graph's `conversationId` is the thread key and
 * `internetMessageId` is the dedup key (analogous to Gmail's threadId / Message-ID
 * header). The sync engine drives this through the shared SyncPorts.
 */

interface GraphRecipient {
  emailAddress?: { address?: string | null; name?: string | null } | null
}
export interface GraphMessage {
  id?: string | null
  conversationId?: string | null
  internetMessageId?: string | null
  subject?: string | null
  receivedDateTime?: string | null
  sentDateTime?: string | null
  from?: GraphRecipient | null
  toRecipients?: GraphRecipient[] | null
  ccRecipients?: GraphRecipient[] | null
  bccRecipients?: GraphRecipient[] | null
  body?: { contentType?: string | null; content?: string | null } | null
}

function addresses(list?: GraphRecipient[] | null): string[] {
  return (list ?? [])
    .map((r) => r.emailAddress?.address?.toLowerCase())
    .filter((a): a is string => Boolean(a))
}

export function parseGraphMessage(m: GraphMessage): ParsedEmail {
  const contentType = (m.body?.contentType ?? '').toLowerCase()
  const content = m.body?.content ?? undefined
  return {
    providerMessageId: `msft:${m.internetMessageId ?? m.id ?? ''}`,
    providerThreadId: `msft:${m.conversationId ?? ''}`,
    messageIdHeader: m.internetMessageId ?? undefined,
    references: [],
    fromAddress: m.from?.emailAddress?.address?.toLowerCase() ?? '',
    toAddresses: addresses(m.toRecipients),
    ccAddresses: addresses(m.ccRecipients),
    bccAddresses: addresses(m.bccRecipients),
    subject: m.subject ?? undefined,
    date: new Date(m.receivedDateTime ?? m.sentDateTime ?? 0),
    bodyText: contentType === 'text' ? content : undefined,
    bodyHtml: contentType === 'html' ? content : undefined,
  }
}

export interface GraphSendMessage {
  internetMessageId: string
  subject?: string | null
  body: { contentType: 'HTML' | 'Text'; content: string }
  toRecipients: Array<{ emailAddress: { address: string } }>
  ccRecipients?: Array<{ emailAddress: { address: string } }>
  bccRecipients?: Array<{ emailAddress: { address: string } }>
}

export class GraphClient {
  constructor(
    private readonly accessToken: string,
    private readonly baseUrl: string = process.env.GRAPH_MOCK_URL ??
      process.env.GRAPH_API_BASE ??
      'https://graph.microsoft.com/v1.0',
  ) {}

  private abs(url: string): string {
    return url.startsWith('http') ? url : `${this.baseUrl}${url}`
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const res = await fetch(this.abs(url), {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })
    if (!res.ok) throw new Error(`graph GET failed: HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  private async postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(this.abs(url), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`graph POST failed: HTTP ${res.status}`)
    const text = await res.text()
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }

  /** Changed inbox conversations since a deltaLink (empty = initial delta). */
  async listChangedConversations(
    cursor: string,
  ): Promise<{ conversationIds: string[]; latestDeltaLink?: string }> {
    let url = cursor && cursor.startsWith('http') ? cursor : '/me/mailFolders/inbox/messages/delta'
    const ids = new Set<string>()
    let latestDeltaLink: string | undefined
    for (let page = 0; page < 50; page++) {
      const data = await this.getJson(url)
      for (const m of (data.value as GraphMessage[]) ?? []) {
        if (m.conversationId) ids.add(m.conversationId)
      }
      const next = data['@odata.nextLink'] as string | undefined
      if (next) {
        url = next
        continue
      }
      latestDeltaLink = data['@odata.deltaLink'] as string | undefined
      break
    }
    return { conversationIds: [...ids], latestDeltaLink }
  }

  /** All messages of a conversation, parsed. */
  async getConversationMessages(conversationId: string): Promise<ParsedEmail[]> {
    const filter = encodeURIComponent(`conversationId eq '${conversationId}'`)
    const data = await this.getJson(`/me/messages?$filter=${filter}`)
    return ((data.value as GraphMessage[]) ?? []).map(parseGraphMessage)
  }

  /** Recent inbox conversation ids (initial backfill). */
  async listConversationsSince(_query: string): Promise<string[]> {
    const data = await this.getJson('/me/mailFolders/inbox/messages?$top=100')
    const ids = new Set<string>()
    for (const m of (data.value as GraphMessage[]) ?? []) {
      if (m.conversationId) ids.add(m.conversationId)
    }
    return [...ids]
  }

  /**
   * Create a draft carrying our client-side `internetMessageId` (the dedup key)
   * then send it. When the Sent copy syncs back, parseGraphMessage derives the
   * same providerMessageId and the @unique constraint short-circuits the insert.
   */
  async createAndSend(message: GraphSendMessage): Promise<void> {
    const draft = await this.postJson('/me/messages', message)
    const id = draft.id as string | undefined
    await this.postJson(`/me/messages/${id}/send`, {})
  }
}
