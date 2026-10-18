import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Brief 41.2 (PR D): Settings → Connected Accounts while Outlook is paused
// (GRAPH_ENABLED is not exactly 'true'). Ryan's instruction: Outlook stays on
// hard pause; switch name confirmed by Ryan 2026-10-17. getMailboxAccounts()
// is what the page renders: the switch is read here, on the server, and only
// the resulting card state reaches the browser.
vi.mock('server-only', () => ({}))
const db = vi.hoisted(() => ({ oAuthCredential: { findUnique: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import { getMailboxAccounts } from '@/lib/settings/queries'

const saved = process.env.GRAPH_ENABLED
afterAll(() => {
  if (saved === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = saved
})
beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.GRAPH_ENABLED
  db.oAuthCredential.findUnique.mockResolvedValue(null)
})

const storedOutlook = {
  provider: 'msft-graph',
  status: 'active',
  emailAddress: 'broker@example.com',
  updatedAt: new Date('2026-10-01T12:00:00Z'),
  graphDeltaLink: null,
  gmailHistoryId: null,
}
const byKey = async () => Object.fromEntries((await getMailboxAccounts()).map((a) => [a.key, a]))

describe('Connected Accounts while Outlook is paused', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['TRUE', 'TRUE'],
    ['1', '1'],
  ])('GRAPH_ENABLED %s: the Outlook card says "Outlook is paused" and has no Connect link', async (_n, value) => {
    if (value !== undefined) process.env.GRAPH_ENABLED = value
    const { outlook, gmail } = await byKey()
    expect(outlook.pausedNote).toMatch(/^Outlook is paused/)
    expect(outlook.connect).toBeNull()
    expect(outlook.disconnect).toBe(false)
    // Everything here is sent to the browser; the sign-in path isn't among it.
    expect(JSON.stringify(outlook)).not.toContain('/api/comms/oauth/msft/authorize')
    // Gmail unchanged.
    expect(gmail.pausedNote).toBeNull()
    expect(gmail.connect).toEqual({ label: 'Connect', href: '/api/comms/oauth/gmail/authorize' })
  })

  it('a stored Outlook connection still shows, with Disconnect', async () => {
    db.oAuthCredential.findUnique.mockImplementation(async ({ where }) =>
      where.organizationId_provider.provider === 'msft-graph' ? storedOutlook : null,
    )
    const { outlook } = await byKey()
    expect(outlook).toMatchObject({ connected: true, emailAddress: 'broker@example.com', disconnect: true, connect: null })
    expect(outlook.pausedNote).toMatch(/^Outlook is paused/)
  })
})

describe('with GRAPH_ENABLED=true', () => {
  it('the Outlook card offers Connect as before', async () => {
    process.env.GRAPH_ENABLED = 'true'
    const { outlook } = await byKey()
    expect(outlook.pausedNote).toBeNull()
    expect(outlook.connect).toEqual({ label: 'Connect', href: '/api/comms/oauth/msft/authorize' })
  })
})
