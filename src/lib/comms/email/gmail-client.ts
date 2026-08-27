import { google, type gmail_v1 } from 'googleapis'
import { parseGmailMessage, type ParsedEmail } from './parse'

/**
 * Thin Gmail API wrapper (brief §2.2 `gmail-client.ts`). Delegates to googleapis;
 * the sync engine talks to it through `SyncPorts`, so business logic stays out of
 * here. Construct with an access token, or inject a `gmail_v1.Gmail` for tests.
 */
export class GmailClient {
  constructor(private readonly gmail: gmail_v1.Gmail) {}

  static forAccessToken(accessToken: string): GmailClient {
    const auth = new google.auth.OAuth2()
    auth.setCredentials({ access_token: accessToken })
    return new GmailClient(google.gmail({ version: 'v1', auth }))
  }

  /** All thread ids matching `query`, following pagination. */
  async listThreadIds(query: string): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined
    do {
      const res = await this.gmail.users.threads.list({
        userId: 'me',
        q: query,
        pageToken,
        maxResults: 100,
      })
      for (const t of res.data.threads ?? []) if (t.id) ids.push(t.id)
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
    return ids
  }

  /** All messages of a thread, parsed. */
  async getThreadMessages(threadId: string): Promise<ParsedEmail[]> {
    const res = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    })
    return (res.data.messages ?? []).map(parseGmailMessage)
  }

  /** Threads changed since `startHistoryId` (messageAdded) + newest historyId. */
  async listChangedThreadIds(
    startHistoryId: string,
  ): Promise<{ threadIds: string[]; latestHistoryId?: string }> {
    const threadIds = new Set<string>()
    let pageToken: string | undefined
    let latestHistoryId: string | undefined
    do {
      const res = await this.gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        pageToken,
        historyTypes: ['messageAdded'],
      })
      latestHistoryId = res.data.historyId ?? latestHistoryId
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const tid = added.message?.threadId
          if (tid) threadIds.add(tid)
        }
      }
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
    return { threadIds: [...threadIds], latestHistoryId }
  }

  /** Send a pre-built RFC 5322 message (base64url raw). Returns the Gmail id. */
  async sendRaw(raw: string): Promise<string | undefined> {
    const res = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    })
    return res.data.id ?? undefined
  }

  /** Register/refresh a push watch on INBOX. */
  async watch(topicName: string): Promise<{ historyId?: string; expiration?: string }> {
    const res = await this.gmail.users.watch({
      userId: 'me',
      requestBody: { topicName, labelIds: ['INBOX'] },
    })
    return {
      historyId: res.data.historyId ?? undefined,
      expiration: res.data.expiration ?? undefined,
    }
  }
}
