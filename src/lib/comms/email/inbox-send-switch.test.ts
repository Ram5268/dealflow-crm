import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Brief 37: the inbox send (POST /api/comms/messages) refuses email while
// EMAIL_ENABLED is not 'true' — before any Message row is written.
const db = vi.hoisted(() => ({ message: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))
const email = vi.hoisted(() => ({ sendEmailMessage: vi.fn() }))
vi.mock('@/lib/comms/email/send', () => email)

import { POST } from '@/app/api/comms/messages/route'

const post = (body: unknown) =>
  new Request('http://crm.test/api/comms/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const compose = { channel: 'email', toAddresses: ['owner@example.com'], subject: 'Hi', bodyText: 'Hello' }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.EMAIL_ENABLED
})
afterAll(() => {
  delete process.env.EMAIL_ENABLED
})

describe('Brief 37: inbox send while email is off', () => {
  it('answers 403 with a clear message before saving or sending anything', async () => {
    const res = await POST(post(compose))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'email_disabled', message: expect.stringContaining('EMAIL_ENABLED') })
    expect(db.message.create).not.toHaveBeenCalled()
    expect(email.sendEmailMessage).not.toHaveBeenCalled()
  })

  it('refuses a scheduled send too, so nothing waits to go out later', async () => {
    const res = await POST(post({ ...compose, scheduleAt: '2026-10-01T15:00:00Z' }))
    expect(res.status).toBe(403)
    expect(db.message.create).not.toHaveBeenCalled()
  })

  it('with EMAIL_ENABLED=true the route saves and sends as before', async () => {
    process.env.EMAIL_ENABLED = 'true'
    db.message.create.mockResolvedValue({ id: 'm1' })
    email.sendEmailMessage.mockResolvedValue({ status: 'sent', providerMessageId: 'gmail:<x>' })
    const res = await POST(post(compose))
    expect(res.status).toBe(200)
    expect(email.sendEmailMessage).toHaveBeenCalledWith('m1')
  })
})
