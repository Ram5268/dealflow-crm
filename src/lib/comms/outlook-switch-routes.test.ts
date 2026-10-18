import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'

// Brief 41.2 (PR D): while Outlook is paused (GRAPH_ENABLED is not exactly
// 'true') the Outlook sign-in routes and the graph-sync cron refuse before
// they touch Microsoft, the database or the job queue. Ryan's instruction:
// Outlook stays on hard pause; switch name confirmed by Ryan 2026-10-17.
// Disconnect stays allowed: Outlook is revoked locally, with no Microsoft call.
const db = vi.hoisted(() => ({
  oAuthCredential: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
const org = vi.hoisted(() => ({ getCurrentOrgId: vi.fn(async () => 'org_1') }))
vi.mock('@/lib/shell/orgContext', () => org)
const jobs = vi.hoisted(() => {
  const send = vi.fn()
  return { send, getBoss: vi.fn(async () => ({ send })) }
})
vi.mock('@/lib/comms/jobs/boss', () => ({ getBoss: jobs.getBoss }))

import { GET as msftAuthorize } from '@/app/api/comms/oauth/msft/authorize/route'
import { GET as msftCallback } from '@/app/api/comms/oauth/msft/callback/route'
import { GET as gmailAuthorize } from '@/app/api/comms/oauth/gmail/authorize/route'
import { GET as graphSyncCron } from '@/app/api/cron/graph-sync/route'
import { POST as revoke } from '@/app/api/oauth/[provider]/revoke/route'
import { signState } from '@/lib/comms/oauth/state'
import { encryptToken } from '@/lib/comms/oauth/crypto'

const ENV_KEYS = [
  'GRAPH_ENABLED',
  'CRON_SECRET',
  'OAUTH_STATE_SECRET',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'MSFT_IDENTITY_BASE',
  'MSFT_GRAPH_TENANT_ID',
  'GRAPH_API_BASE',
  'GRAPH_MOCK_URL',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
beforeAll(() => {
  // Test-only values, set before any route reads them.
  process.env.CRON_SECRET = 'cron-test-secret'
  process.env.OAUTH_STATE_SECRET = 'state-test-secret'
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  for (const k of ['MSFT_IDENTITY_BASE', 'MSFT_GRAPH_TENANT_ID', 'GRAPH_API_BASE', 'GRAPH_MOCK_URL'] as const) {
    delete process.env[k]
  }
})
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  delete process.env.GRAPH_ENABLED
})
afterEach(() => vi.unstubAllGlobals())

// The values that must all mean "paused".
const OFF = [
  ['unset', undefined],
  ['empty', ''],
  ['TRUE', 'TRUE'],
  ['1', '1'],
] as const
function setGraph(value: string | undefined) {
  if (value === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = value
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const callbackReq = () => {
  const state = signState({ orgId: 'org_1', provider: 'msft-graph' })
  return new Request(`https://crm.test/api/comms/oauth/msft/callback?code=abc&state=${encodeURIComponent(state)}`)
}
const cronReq = (secret = 'cron-test-secret') =>
  new Request('https://crm.test/api/cron/graph-sync', { headers: { authorization: `Bearer ${secret}` } })
const revokeOutlook = () =>
  revoke(new Request('https://crm.test/api/oauth/outlook/revoke', { method: 'POST' }), {
    params: Promise.resolve({ provider: 'outlook' }),
  })

describe('Outlook sign-in while Outlook is paused', () => {
  it.each(OFF)('authorize (GRAPH_ENABLED %s): 403 with a plain message, no redirect to Microsoft', async (_n, value) => {
    setGraph(value)
    const res = await msftAuthorize()
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toMatchObject({ error: 'outlook_paused', message: expect.stringMatching(/^Outlook is paused/) })
    expect(org.getCurrentOrgId).not.toHaveBeenCalled()
  })

  it.each(OFF)('callback (GRAPH_ENABLED %s): 403, no code exchange, no token stored', async (_n, value) => {
    setGraph(value)
    const res = await msftCallback(callbackReq())
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toMatchObject({ error: 'outlook_paused', message: expect.stringMatching(/^Outlook is paused/) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.oAuthCredential.upsert).not.toHaveBeenCalled()
  })

  it('Gmail sign-in is unchanged', async () => {
    const res = await gmailAuthorize()
    expect(res.headers.get('location')).toContain('accounts.google.com')
  })
})

describe('Outlook sign-in with GRAPH_ENABLED=true (mocked Microsoft)', () => {
  it('authorize redirects to the Microsoft consent screen as before', async () => {
    setGraph('true')
    const res = await msftAuthorize()
    expect([302, 307]).toContain(res.status)
    expect(res.headers.get('location')).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize')
  })

  it('callback exchanges the code and stores the connection as before', async () => {
    setGraph('true')
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ mail: 'broker@example.com' }))
    db.oAuthCredential.upsert.mockResolvedValue({ id: 'cred-m' })
    const res = await msftCallback(callbackReq())
    expect(res.headers.get('location')).toContain('connected=msft')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/oauth2/v2.0/token')
    expect(db.oAuthCredential.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_provider: { organizationId: 'org_1', provider: 'msft-graph' } },
      }),
    )
  })
})

describe('graph-sync cron', () => {
  it.each(OFF)('GRAPH_ENABLED %s: { ran: false, reason: "outlook paused" }, nothing read or queued', async (_n, value) => {
    setGraph(value)
    db.oAuthCredential.findMany.mockResolvedValue([{ id: 'c1' }])
    const res = await graphSyncCron(cronReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ran: false, reason: 'outlook paused' })
    expect(db.oAuthCredential.findMany).not.toHaveBeenCalled()
    expect(jobs.getBoss).not.toHaveBeenCalled()
    expect(jobs.send).not.toHaveBeenCalled()
  })

  it('a wrong secret is still refused first (401)', async () => {
    const res = await graphSyncCron(cronReq('wrong'))
    expect(res.status).toBe(401)
    expect(jobs.getBoss).not.toHaveBeenCalled()
  })

  it('with GRAPH_ENABLED=true it queues one sync per active Outlook connection, as before', async () => {
    setGraph('true')
    db.oAuthCredential.findMany.mockResolvedValue([{ id: 'c1' }])
    const res = await graphSyncCron(cronReq())
    expect(await res.json()).toMatchObject({ ran: true, processed: 1 })
    expect(jobs.send).toHaveBeenCalledWith('graph-delta-sync', { credentialId: 'c1' }, { singletonKey: 'graph:c1' })
  })
})

describe('Disconnect Outlook stays allowed while Outlook is paused', () => {
  it.each(OFF)('GRAPH_ENABLED %s: the stored connection is revoked locally, with no Microsoft call', async (_n, value) => {
    setGraph(value)
    db.oAuthCredential.findUnique.mockResolvedValue({
      id: 'cred-m',
      provider: 'msft-graph',
      status: 'active',
      accessTokenEncrypted: encryptToken('AT'),
      refreshTokenEncrypted: encryptToken('RT'),
    })
    db.oAuthCredential.update.mockResolvedValue({})
    const res = await revokeOutlook()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true, provider: 'outlook', remoteRevocation: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.oAuthCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cred-m' }, data: expect.objectContaining({ status: 'revoked' }) }),
    )
  })
})
