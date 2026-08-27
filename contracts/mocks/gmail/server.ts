import http from 'node:http'
import { readRaw, sendJson } from '../_util'

/**
 * Gmail API mock — emulates the googleapis REST surface GmailClient hits. Point
 * the client at it via GMAIL_MOCK_URL / rootUrl. Serves ONE inbound thread so the
 * delta-sync smoke can reconstruct a thread, insert a message, and emit
 * message.received end-to-end.
 */
const b64url = (s: string) => Buffer.from(s).toString('base64url')

function inboundMessage() {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: String(Date.UTC(2026, 7, 8, 15, 0, 0)),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'buyer@example.com' },
        { name: 'To', value: 'ryan@example.com' },
        { name: 'Subject', value: 'Interested in your listing' },
        { name: 'Message-ID', value: '<buyer-1@mail.example.com>' },
      ],
      body: { data: b64url('Is it still available?') },
    },
  }
}

export function start(port = Number(process.env.GMAIL_MOCK_PORT ?? 4003)): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname

    if (req.method === 'GET' && p === '/_mock/health') {
      return sendJson(res, 200, { ok: true, mock: 'gmail' })
    }
    if (p.endsWith('/users/me/profile')) {
      return sendJson(res, 200, {
        emailAddress: 'ryan@example.com',
        messagesTotal: 1,
        threadsTotal: 1,
        historyId: '1',
      })
    }
    if (p.endsWith('/users/me/threads') && req.method === 'GET') {
      return sendJson(res, 200, { threads: [{ id: 't1' }], resultSizeEstimate: 1 })
    }
    if (/\/users\/me\/threads\/[^/]+$/.test(p) && req.method === 'GET') {
      return sendJson(res, 200, { id: 't1', historyId: '999', messages: [inboundMessage()] })
    }
    if (p.endsWith('/users/me/history') && req.method === 'GET') {
      return sendJson(res, 200, {
        history: [{ id: '2', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
        historyId: '999',
      })
    }
    if (p.endsWith('/users/me/messages/send') && req.method === 'POST') {
      await readRaw(req)
      return sendJson(res, 200, { id: 'sent1', threadId: 't1' })
    }
    if (p.endsWith('/users/me/watch') && req.method === 'POST') {
      await readRaw(req)
      return sendJson(res, 200, {
        historyId: '100',
        expiration: String(Date.UTC(2026, 7, 15, 0, 0, 0)),
      })
    }

    sendJson(res, 404, { error: 'not_found', path: p })
  })

  server.listen(port)
  return server
}
