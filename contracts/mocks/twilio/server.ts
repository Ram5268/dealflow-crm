import http from 'node:http'
import { readRaw, sendJson } from '../_util'

/**
 * Twilio Programmable Messaging mock — POST Messages.json returns a queued SID.
 * Point the app at it with TWILIO_API_BASE=http://localhost:4002.
 */
export function start(port = Number(process.env.TWILIO_MOCK_PORT ?? 4002)): http.Server {
  let counter = 0

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/_mock/health') {
      return sendJson(res, 200, { ok: true, mock: 'twilio' })
    }

    if (
      req.method === 'POST' &&
      /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/.test(url.pathname)
    ) {
      await readRaw(req) // drain body; we don't need to inspect it
      const sid = `SM${String(++counter).padStart(32, '0')}`
      return sendJson(res, 201, { sid, status: 'queued' })
    }

    sendJson(res, 404, { error: 'not_found' })
  })

  server.listen(port)
  return server
}
