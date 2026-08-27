import http from 'node:http'
import { readRaw, sendJson } from '../_util'

/**
 * Microsoft Graph mock — emulates the REST surface GraphClient + oauth/graph hit.
 * Serves one inbound conversation so the Graph delta-sync smoke can reconstruct a
 * thread, insert a message, and emit message.received — mirroring the Gmail mock.
 */
function inboundMessage() {
  return {
    id: 'gm1',
    conversationId: 'conv1',
    internetMessageId: '<outlook-buyer-1@mail.example.com>',
    subject: 'Interested via Outlook',
    receivedDateTime: '2026-08-08T16:00:00Z',
    from: { emailAddress: { address: 'obuyer@example.com' } },
    toRecipients: [{ emailAddress: { address: 'ryan@outlook.com' } }],
    body: { contentType: 'text', content: 'Is the co-op still available?' },
  }
}

export function start(port = Number(process.env.GRAPH_MOCK_PORT ?? 4004)): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname

    if (req.method === 'GET' && p === '/_mock/health') {
      return sendJson(res, 200, { ok: true, mock: 'graph' })
    }
    if (p.endsWith('/me') && req.method === 'GET') {
      return sendJson(res, 200, { mail: 'ryan@outlook.com', userPrincipalName: 'ryan@elliman.onmicrosoft.com' })
    }
    if (p.endsWith('/messages/delta')) {
      // First delta (no token) returns the conversation; with a token, returns empty.
      const hasToken = url.searchParams.has('token') || url.searchParams.has('$deltatoken')
      return sendJson(res, 200, {
        value: hasToken ? [] : [inboundMessage()],
        '@odata.deltaLink': `https://graph.mock/delta?token=next`,
      })
    }
    if (/\/me\/messages$/.test(p) && req.method === 'GET') {
      // $filter=conversationId eq '...'
      return sendJson(res, 200, { value: [inboundMessage()] })
    }
    if (/\/me\/messages$/.test(p) && req.method === 'POST') {
      await readRaw(req) // draft create
      return sendJson(res, 201, { id: 'draft1' })
    }
    if (/\/me\/messages\/[^/]+\/send$/.test(p) && req.method === 'POST') {
      await readRaw(req)
      res.writeHead(202)
      return res.end()
    }

    sendJson(res, 404, { error: 'not_found', path: p })
  })

  server.listen(port)
  return server
}
