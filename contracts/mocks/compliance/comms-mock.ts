import http from 'node:http'
import { readJson, sendJson } from '../_util'

/**
 * Comms behavioral compliance mock (Agent D — gate1:smoke / comms:isolated).
 *
 * A stand-in for Agent C's compliance service that keeps an in-memory DNC ledger
 * shared across /scrub and /dnc/internal, so the SMS STOP → /dnc/internal →
 * /scrub-blocks flow is exercisable in isolation: adding a phone via /dnc/internal
 * makes /scrub return callable:false for it. Reasons draw from REASON_CODES.
 *
 * NOTE: the CANONICAL compliance *contract* mock is ./server.ts (Agent A/C —
 * callable-now wire shape + timezone fail-close fidelity, consumed by
 * contracts/tests + the boot scripts). This file is intentionally separate: it
 * exists only to drive Agent D's behavioral smoke, which needs /scrub +
 * /dnc/internal endpoints the canonical contract mock does not model.
 */
export function start(port = Number(process.env.COMPLIANCE_MOCK_PORT ?? 4001)): http.Server {
  const dnc = new Set<string>()
  let counter = 0

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { pathname } = url

    if (req.method === 'GET' && pathname === '/_mock/health') {
      return sendJson(res, 200, { ok: true, mock: 'compliance' })
    }

    if (req.method === 'POST' && pathname === '/scrub') {
      const body = await readJson(req)
      const phones = (body.phones as string[]) ?? []
      const results = phones.map((phone) => {
        const blocked = dnc.has(phone) || phone.endsWith('0000')
        return { phone, callable: !blocked, reasons: blocked ? ['internal_dnc'] : [] }
      })
      return sendJson(res, 200, { results })
    }

    if (req.method === 'POST' && pathname === '/dnc/internal') {
      const body = await readJson(req)
      const phone = String(body.phone ?? '')
      const already = dnc.has(phone)
      dnc.add(phone)
      const base = {
        id: `dnc_${++counter}`,
        phone,
        source: 'internal',
        addedAt: new Date().toISOString(),
      }
      const payload =
        url.searchParams.get('legacy') === '1' ? base : { ...base, added: !already }
      return sendJson(res, 201, payload)
    }

    if (req.method === 'POST' && pathname === '/callable-now') {
      const body = await readJson(req)
      const ids = (body.contactPhoneIds as string[]) ?? []
      if (ids.length > 100) return sendJson(res, 413, { error: 'batch_cap_exceeded' })
      const results = ids.map((contactPhoneId, i) => ({
        contactPhoneId,
        phone: `+1555${String(i).padStart(7, '0')}`,
        callable: true,
        reasons: [] as string[],
      }))
      return sendJson(res, 200, { results })
    }

    sendJson(res, 404, { error: 'not_found' })
  })

  server.listen(port)
  return server
}
