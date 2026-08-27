import http from 'node:http'
import { readRaw, sendJson } from '../_util'

/**
 * Microsoft Graph mock — minimal. Milestone 5 (Graph mirror) isn't wired yet, so
 * this serves _mock/health plus stub delta + sendMail endpoints so the isolation
 * env has all four mocks present and the contract layer can grow into it.
 */
export function start(port = Number(process.env.GRAPH_MOCK_PORT ?? 4004)): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname

    if (req.method === 'GET' && p === '/_mock/health') {
      return sendJson(res, 200, { ok: true, mock: 'graph' })
    }
    if (p.endsWith('/messages/delta')) {
      return sendJson(res, 200, {
        value: [],
        '@odata.deltaLink': 'https://graph.mock/delta?token=stub',
      })
    }
    if (p.endsWith('/sendMail') && req.method === 'POST') {
      await readRaw(req)
      res.writeHead(202)
      return res.end()
    }

    sendJson(res, 404, { error: 'not_found', path: p })
  })

  server.listen(port)
  return server
}
