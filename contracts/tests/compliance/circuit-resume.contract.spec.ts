import { describe, it, expect, beforeEach } from 'vitest'
import { POST } from '@/app/api/compliance/circuit/resume/route'
import { resetEnvCache } from '@/lib/compliance/env'

// Gate 2 — circuit resume auth + validation. Bearer CRON_SECRET required.
const SECRET = 'test-cron-secret'

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  resetEnvCache()
})

function post(body: unknown, auth?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-correlation-id': 't' }
  if (auth) headers.authorization = auth
  return POST(new Request('http://local/api/compliance/circuit/resume', { method: 'POST', headers, body: JSON.stringify(body) }))
}

describe('POST /api/compliance/circuit/resume', () => {
  it('401 without bearer', async () => {
    const res = await post({ circuit: 'dnc', operatorLabel: 'x' })
    expect(res.status).toBe(401)
  })

  it('401 with a wrong bearer', async () => {
    const res = await post({ circuit: 'dnc', operatorLabel: 'x' }, 'Bearer nope')
    expect(res.status).toBe(401)
  })

  it('400 for an invalid circuit value (past auth)', async () => {
    const res = await post({ circuit: 'bogus', operatorLabel: 'x' }, `Bearer ${SECRET}`)
    expect(res.status).toBe(400)
  })
})
