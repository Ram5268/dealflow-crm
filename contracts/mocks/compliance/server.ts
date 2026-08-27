import http from 'node:http'
import { REASON_CODES } from '../../http/reason-codes'

// ─────────────────────────────────────────────────────────────────────────────
// Mock of Agent C's POST /api/compliance/callable-now. Faithful to the locked
// contract so A's contract tests can validate both directions in isolation:
//  - enforces the 100-ids-per-batch cap with HTTP 413;
//  - responds with { results: [{ contactPhoneId, phone, callable, reasons }] };
//  - `reasons` values are drawn ONLY from the frozen REASON_CODES enum;
//  - models C's timezone fail-close: an entry with no timezone → callable:false
//    reasons:['timezone_unresolved']; a phone containing 'dnc' → internal_dnc.
// node:http keeps this dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BATCH = 100

interface Entry {
  contactPhoneId: string
  phone: string
  timezone?: string
}

export interface MockResult {
  contactPhoneId: string
  phone: string
  callable: boolean
  reasons: string[]
}

export function computeResults(
  contactPhoneIds: string[],
  entries: Entry[] | undefined
): MockResult[] {
  const entryById = new Map((entries ?? []).map((e) => [e.contactPhoneId, e]))
  return contactPhoneIds.map((id) => {
    const e = entryById.get(id)
    const phone = e?.phone ?? ''
    const reasons: string[] = []
    // Model C's fail-close on an unresolved timezone.
    if (e && e.timezone === undefined) reasons.push('timezone_unresolved')
    if (phone.toLowerCase().includes('dnc')) reasons.push('internal_dnc')
    return { contactPhoneId: id, phone, callable: reasons.length === 0, reasons }
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/compliance/callable-now') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const ids: string[] = body.contactPhoneIds ?? []
        if (!Array.isArray(ids)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'contactPhoneIds must be an array' }))
          return
        }
        if (ids.length > MAX_BATCH) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: `batch exceeds ${MAX_BATCH} ids` }))
          return
        }
        const results = computeResults(ids, body.entries)
        // Safety: never emit a reason outside the frozen enum.
        for (const r of results) {
          r.reasons = r.reasons.filter((x) => (REASON_CODES as readonly string[]).includes(x))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results }))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json' }))
      }
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
}

export function start(port = 5555): http.Server {
  const server = createServer()
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`mock compliance server listening on :${port}`)
  })
  return server
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  start(Number(process.env.MOCK_COMPLIANCE_PORT) || 5555)
}
