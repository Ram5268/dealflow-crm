import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Brief 41.2 (PR D): while Outlook is paused (GRAPH_ENABLED is not exactly
// 'true') a queued Outlook sync finishes without work: no credential read, no
// token refresh, no Microsoft call, and no error for pg-boss to retry. Ryan's
// instruction: Outlook stays on hard pause; switch name confirmed by Ryan
// 2026-10-17.
const db = vi.hoisted(() => ({ oAuthCredential: { findUnique: vi.fn() } }))
vi.mock('../../prisma', () => ({ prisma: db }))
const store = vi.hoisted(() => ({
  getDecryptedAccessToken: vi.fn(() => 'AT'),
  getDecryptedRefreshToken: vi.fn(() => 'RT'),
  updateAccessToken: vi.fn(),
}))
vi.mock('../oauth/store', () => store)
const graphOAuth = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
vi.mock('../oauth/graph', () => graphOAuth)
const adapter = vi.hoisted(() => ({ createGraphSyncPorts: vi.fn(() => ({ fake: 'ports' })) }))
vi.mock('../email/graph-adapter', () => adapter)
const sync = vi.hoisted(() => ({ deltaSync: vi.fn() }))
vi.mock('../email/gmail-sync', () => sync)

import { runGraphSyncForCredential } from './graph-runner'
import { handleGraphDeltaJob } from './graph-delta'

const saved = process.env.GRAPH_ENABLED
afterAll(() => {
  if (saved === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = saved
})
beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.GRAPH_ENABLED
})

// A connected Outlook mailbox whose access token has expired.
const msftCred = () => ({
  id: 'cred-m',
  organizationId: 'o',
  provider: 'msft-graph',
  status: 'active',
  emailAddress: 'broker@example.com',
  expiresAt: new Date(Date.now() - 1000),
  graphDeltaLink: 'https://graph.test/delta?token=1',
})

function expectNothingTouched() {
  expect(db.oAuthCredential.findUnique).not.toHaveBeenCalled()
  expect(graphOAuth.refreshAccessToken).not.toHaveBeenCalled()
  expect(store.updateAccessToken).not.toHaveBeenCalled()
  expect(adapter.createGraphSyncPorts).not.toHaveBeenCalled()
  expect(sync.deltaSync).not.toHaveBeenCalled()
}

describe('Outlook sync while Outlook is paused', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['TRUE', 'TRUE'],
    ['1', '1'],
  ])('GRAPH_ENABLED %s: the job is dropped before the credential is read', async (_n, value) => {
    if (value !== undefined) process.env.GRAPH_ENABLED = value
    db.oAuthCredential.findUnique.mockResolvedValue(msftCred())
    expect(await runGraphSyncForCredential('cred-m')).toEqual({ skipped: true })
    expectNothingTouched()
  })

  it('the graph-delta-sync worker finishes every job (no retry) and syncs nothing', async () => {
    db.oAuthCredential.findUnique.mockResolvedValue(msftCred())
    await expect(
      handleGraphDeltaJob([{ data: { credentialId: 'a' } }, { data: { credentialId: 'b' } }]),
    ).resolves.toBeUndefined()
    expectNothingTouched()
  })
})

describe('with GRAPH_ENABLED=true (mocked Graph)', () => {
  it('refreshes a stale token and runs the delta sync, as before', async () => {
    process.env.GRAPH_ENABLED = 'true'
    db.oAuthCredential.findUnique.mockResolvedValue(msftCred())
    graphOAuth.refreshAccessToken.mockResolvedValue({ accessToken: 'AT2', expiresAt: new Date(Date.now() + 3_600_000) })
    sync.deltaSync.mockResolvedValue({ threads: 1, messagesInserted: 1, emitted: 1, historyId: 'DL2' })

    expect(await runGraphSyncForCredential('cred-m')).toEqual({ threads: 1, messagesInserted: 1, emitted: 1, historyId: 'DL2' })
    expect(graphOAuth.refreshAccessToken).toHaveBeenCalledWith('RT')
    expect(store.updateAccessToken).toHaveBeenCalledWith('cred-m', 'AT2', expect.any(Date))
    expect(adapter.createGraphSyncPorts).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'cred-m', accessToken: 'AT2' }))
    expect(sync.deltaSync).toHaveBeenCalledWith({ fake: 'ports' }, 'https://graph.test/delta?token=1')
  })

  it('still skips a credential that is not an active Outlook one', async () => {
    process.env.GRAPH_ENABLED = 'true'
    db.oAuthCredential.findUnique.mockResolvedValue({ ...msftCred(), status: 'revoked' })
    expect(await runGraphSyncForCredential('cred-m')).toEqual({ skipped: true })
    expect(sync.deltaSync).not.toHaveBeenCalled()
  })
})
