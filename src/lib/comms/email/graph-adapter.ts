import { GraphClient } from './graph-client'
import { updateGraphDeltaLink } from '../oauth/store'
import type { SyncPorts } from './gmail-sync'
// The persist ports (contact resolution, thread upsert, message save, NOTIFY) are
// provider-agnostic — reused from the Gmail adapter so Graph and Gmail share one
// reconstruction + dedup path.
import { resolveContact, upsertThread, saveMessages, emitMessageReceived } from './gmail-adapter'

/**
 * Graph `SyncPorts` implementation (brief §M5). Maps Graph's conversation/delta
 * model onto the same orchestration `gmail-sync.ts` runs: `listChangedThreadIds`
 * carries the `@odata.deltaLink` as the cursor, `setHistoryId` persists it to
 * `graphDeltaLink`. GraphClient reads GRAPH_MOCK_URL for isolation.
 */
export function createGraphSyncPorts(params: {
  orgId: string
  credentialId: string
  connectedEmail: string
  accessToken: string
}): SyncPorts {
  const gc = new GraphClient(params.accessToken)
  return {
    connectedEmail: params.connectedEmail,
    listThreadIds: (query) => gc.listConversationsSince(query),
    getThreadMessages: (conversationId) => gc.getConversationMessages(conversationId),
    listChangedThreadIds: async (startCursor) => {
      const { conversationIds, latestDeltaLink } = await gc.listChangedConversations(startCursor)
      return { threadIds: conversationIds, latestHistoryId: latestDeltaLink }
    },
    resolveContact: (emails) => resolveContact(params.orgId, emails),
    upsertThread: (agg) => upsertThread(params.orgId, agg),
    saveMessages: (rows) => saveMessages(params.orgId, rows),
    emitMessageReceived: (msg) => emitMessageReceived(msg),
    setHistoryId: async (deltaLink) => {
      await updateGraphDeltaLink(params.credentialId, deltaLink)
    },
  }
}
