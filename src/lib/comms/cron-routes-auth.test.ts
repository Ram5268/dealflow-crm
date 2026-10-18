import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

// Brief 41.2 (PR F), an engineering precaution from the Oct 16, 2026 system-map
// review: the gmail-sync, graph-sync and sequences-tick crons compared the
// header with `Bearer ${process.env.CRON_SECRET}`, so with the secret unset
// "Bearer undefined" was let in. They now use the shared check dnc-refresh and
// holiday-refresh use, which refuses when the secret is unset or empty.
const db = vi.hoisted(() => ({ oAuthCredential: { findMany: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
const boss = vi.hoisted(() => ({ send: vi.fn() }))
const jobs = vi.hoisted(() => ({ getBoss: vi.fn() }))
vi.mock('@/lib/comms/jobs/boss', () => jobs)
const tick = vi.hoisted(() => ({ runSequenceTick: vi.fn() }))
vi.mock('@/lib/comms/sequences/tick', () => tick)

import { GET as gmailSync } from '@/app/api/cron/gmail-sync/route'
import { GET as graphSync } from '@/app/api/cron/graph-sync/route'
import { GET as sequencesTick } from '@/app/api/cron/sequences-tick/route'
import { resetEnvCache } from '@/lib/compliance/env'

const SECRET = 'test-cron-secret-0123456789'
// Taken when this file starts, so the restore undoes only its own changes.
let savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  savedEnv = { ...process.env }
})

const call = (route: (req: Request) => Promise<Response>, authorization?: string) =>
  route(new Request('https://crm.example/api/cron/x', authorization === undefined ? {} : { headers: { authorization } }))

// Each route, and what it does once it is let in (all mocked here).
const ROUTES = [
  { name: 'gmail-sync', route: gmailSync, didWork: () => db.oAuthCredential.findMany.mock.calls.length + jobs.getBoss.mock.calls.length > 0 },
  { name: 'graph-sync', route: graphSync, didWork: () => db.oAuthCredential.findMany.mock.calls.length + jobs.getBoss.mock.calls.length > 0 },
  { name: 'sequences-tick', route: sequencesTick, didWork: () => tick.runSequenceTick.mock.calls.length > 0 },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  db.oAuthCredential.findMany.mockResolvedValue([{ id: 'cred_1' }])
  jobs.getBoss.mockResolvedValue(boss)
  boss.send.mockResolvedValue('job_1')
  tick.runSequenceTick.mockResolvedValue({ processed: 0, sent: 0, finished: 0, errored: 0 })
  delete process.env.CRON_SECRET
  // Only so the Outlook off-switch (Brief 41.2 PR D) can't be what stops
  // graph-sync here: this file tests the job key alone. Test process only.
  process.env.GRAPH_ENABLED = 'true'
  resetEnvCache()
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  resetEnvCache()
})

describe.each(ROUTES)('GET /api/cron/$name refuses without the right job key', ({ route, didWork }) => {
  it('secret unset: "Bearer undefined" is refused, and nothing runs', async () => {
    const res = await call(route, 'Bearer undefined')
    expect(res.status).toBe(401)
    expect(didWork()).toBe(false)
  })

  it('secret unset: no header, or an empty bearer, is refused', async () => {
    expect((await call(route)).status).toBe(401)
    expect((await call(route, 'Bearer ')).status).toBe(401)
    expect(didWork()).toBe(false)
  })

  it('secret set but empty: refused (an empty key is no key)', async () => {
    process.env.CRON_SECRET = ''
    resetEnvCache()
    expect((await call(route, 'Bearer ')).status).toBe(401)
    expect(didWork()).toBe(false)
  })

  it('secret set: a wrong key, or none, is refused', async () => {
    process.env.CRON_SECRET = SECRET
    resetEnvCache()
    expect((await call(route, `Bearer ${SECRET}x`)).status).toBe(401)
    expect((await call(route, SECRET)).status).toBe(401)
    expect((await call(route)).status).toBe(401)
    expect(didWork()).toBe(false)
  })

  it('secret set: the right key proceeds', async () => {
    process.env.CRON_SECRET = SECRET
    resetEnvCache()
    const res = await call(route, `Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ran: true })
    expect(didWork()).toBe(true)
  })
})
