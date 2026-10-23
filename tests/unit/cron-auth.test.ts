import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { resetEnvCache } from '@/lib/compliance/env'
import { GET as dealflowSignalSync } from '@/app/api/cron/dealflow-signal-sync/route'

// Brief 50 (PR 11), open item 6.11, an engineering precaution: the job-key
// check compares in constant time, so how long a wrong key takes to refuse
// says nothing about how much of it was right. Both sides are hashed to 32
// bytes and compared with crypto.timingSafeEqual, so even the key's length
// isn't given away. It still refuses everything when CRON_SECRET is unset,
// empty or only spaces. The morning copy's route (/api/cron/dealflow-signal-sync)
// used its own non-constant-time check; it now uses this one, like the other
// crons. No database: every request here is refused before any read.
const SECRET = 'test-cron-secret-0123456789'
let savedEnv: Record<string, string | undefined> = {}
let compare: ReturnType<typeof vi.spyOn>

const req = (authorization?: string) =>
  new Request('https://crm.example/api/cron/x', authorization === undefined ? {} : { headers: { authorization } })
const syncReq = (authorization?: string) =>
  new NextRequest('https://crm.example/api/cron/dealflow-signal-sync', authorization === undefined ? {} : { headers: { authorization } })
const setSecret = (value: string | undefined) => {
  if (value === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = value
  resetEnvCache()
}

beforeAll(() => {
  savedEnv = { ...process.env }
})
beforeEach(() => {
  compare = vi.spyOn(crypto, 'timingSafeEqual')
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  resetEnvCache()
})

describe('isAuthorizedCron compares the job key in constant time', () => {
  it('the right key is let in, through timingSafeEqual on two 32-byte digests', () => {
    setSecret(SECRET)
    expect(isAuthorizedCron(req(`Bearer ${SECRET}`))).toBe(true)
    expect(compare).toHaveBeenCalledTimes(1)
    const [a, b] = compare.mock.calls[0] as [Buffer, Buffer]
    expect([a.length, b.length]).toEqual([32, 32])
  })

  it('a wrong key of any length is refused the same way: always one constant-time comparison of equal-length digests', () => {
    setSecret(SECRET)
    const wrong = [
      `Bearer ${SECRET.slice(0, -1)}x`, // same length, last character wrong
      `Bearer ${SECRET.slice(0, -1)}`, // a prefix
      `Bearer ${SECRET}x`, // longer
      `Bearer x`,
      'Bearer ',
      SECRET, // the key with no "Bearer "
    ]
    for (const header of wrong) expect(isAuthorizedCron(req(header)), header).toBe(false)
    expect(compare).toHaveBeenCalledTimes(wrong.length)
    for (const [a, b] of compare.mock.calls as [Buffer, Buffer][]) expect([a.length, b.length]).toEqual([32, 32])
  })

  it('no header: refused', () => {
    setSecret(SECRET)
    expect(isAuthorizedCron(req())).toBe(false)
  })

  it('secret unset, empty or only spaces: everything is refused (an empty key is no key)', () => {
    for (const secret of [undefined, '', '   ']) {
      setSecret(secret)
      for (const header of [undefined, 'Bearer undefined', 'Bearer ', `Bearer ${secret ?? ''}`, 'Bearer    ']) {
        expect(isAuthorizedCron(req(header)), `${JSON.stringify(secret)} / ${JSON.stringify(header)}`).toBe(false)
      }
    }
  })
})

describe('the morning copy route uses that check', () => {
  it('refuses a wrong key, through the constant-time comparison', async () => {
    setSecret(SECRET)
    const res = await dealflowSignalSync(syncReq(`Bearer ${SECRET}x`))
    expect(res.status).toBe(401)
    expect(compare).toHaveBeenCalled()
  })

  it('refuses the bare key with no "Bearer " (its old check let that in), and no header', async () => {
    setSecret(SECRET)
    expect((await dealflowSignalSync(syncReq(SECRET))).status).toBe(401)
    expect((await dealflowSignalSync(syncReq())).status).toBe(401)
  })

  it('secret unset, empty or only spaces: refused', async () => {
    for (const secret of [undefined, '', '   ']) {
      setSecret(secret)
      expect((await dealflowSignalSync(syncReq('Bearer undefined'))).status).toBe(401)
      expect((await dealflowSignalSync(syncReq(`Bearer ${secret ?? ''}`))).status).toBe(401)
    }
  })
})
