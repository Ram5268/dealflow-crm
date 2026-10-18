import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Brief 41.2 (PR E): resuming an enrollment (setting it back to 'active') is
// refused while a channel its sequence uses is off, the same check as a new
// enrollment. Engineering precaution (audit H15), serving Ryan's instruction
// that nothing contacts a lead: a resumed enrollment would fire at switch-on
// just like a new one. Pausing and cancelling stay allowed. The refusal comes
// before anything is written. The switches are set only in this test's process.
const db: any = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  })
  return {
    sequence: model(),
    sequenceEnrollment: model(),
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  }
})
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import { PATCH } from '@/app/api/comms/enrollments/[id]/route'
import { updateEnrollment } from './crud'

const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']
function writes(): string[] {
  const out: string[] = []
  for (const [name, m] of Object.entries<any>(db)) {
    if (typeof m === 'function') {
      if (m.mock.calls.length > 0) out.push(name)
      continue
    }
    for (const w of WRITES) if (m[w].mock.calls.length > 0) out.push(`${name}.${w}`)
  }
  return out
}

const sequence = (channel: string, ...steps: string[]) => ({ channel, steps: steps.map((c) => ({ channel: c })) })
const EMAIL_ONLY = sequence('email', 'email', 'email')
const SMS_ONLY = sequence('sms', 'sms')
const MIXED = sequence('mixed', 'email', 'sms')

/** A paused enrollment in `seq`. */
function given(seq: unknown) {
  db.sequenceEnrollment.findFirst.mockResolvedValue({ sequence: seq })
  db.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 })
}

const SWITCHES = ['EMAIL_ENABLED', 'SMS_ENABLED'] as const
const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]))
function set(name: (typeof SWITCHES)[number], value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
function switches(email: string | undefined, sms: string | undefined) {
  set('EMAIL_ENABLED', email)
  set('SMS_ENABLED', sms)
}

beforeEach(() => {
  vi.clearAllMocks()
  switches(undefined, undefined)
})
afterAll(() => {
  for (const k of SWITCHES) set(k, saved[k])
})

const patch = (status: string) =>
  PATCH(
    new Request('http://crm.test/api/comms/enrollments/enr_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: 'enr_1' }) },
  )

async function refused(res: Response, message: string, channels: string[]) {
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'sequence_channel_off', message, channels })
  expect(writes()).toEqual([])
  // The enrollment's own sequence, in this organization, is what's checked.
  expect(db.sequenceEnrollment.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'enr_1', organizationId: 'org_1' } }),
  )
}

describe('PATCH /api/comms/enrollments/[id] resume while a channel the sequence uses is off', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', ' true'])(
    'an email sequence: refused while EMAIL_ENABLED is %j (texting on does not help)',
    async (value) => {
      switches(value, 'true')
      given(EMAIL_ONLY)
      await refused(await patch('active'), "Email is off, so this sequence can't start.", ['email'])
    },
  )

  it('an email sequence: refused while both are off (today)', async () => {
    given(EMAIL_ONLY)
    await refused(await patch('active'), "Email is off, so this sequence can't start.", ['email'])
  })

  it.each([undefined, '', 'TRUE', '1'])('a text sequence: refused while SMS_ENABLED is %j', async (value) => {
    switches('true', value)
    given(SMS_ONLY)
    await refused(await patch('active'), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it('a mixed sequence: refused with texting off', async () => {
    switches('true', undefined)
    given(MIXED)
    await refused(await patch('active'), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it('a mixed sequence: refused with email off', async () => {
    switches(undefined, 'true')
    given(MIXED)
    await refused(await patch('active'), "Email is off, so this sequence can't start.", ['email'])
  })

  it('a mixed sequence: refused with both off, naming both', async () => {
    given(MIXED)
    await refused(await patch('active'), "Email and texting are off, so this sequence can't start.", ['email', 'sms'])
  })

  it("a step's channel counts even when the sequence is labelled email", async () => {
    switches('true', undefined)
    given(sequence('email', 'email', 'sms'))
    await refused(await patch('active'), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it("a channel the CRM can't send counts as off, even with both switches on", async () => {
    switches('true', 'true')
    given(sequence('email', 'voice'))
    await refused(await patch('active'), "This sequence uses a channel the CRM can't send, so it can't start.", ['voice'])
  })
})

describe('PATCH /api/comms/enrollments/[id] resume with every channel on (mocked)', () => {
  const resumed = { where: { id: 'enr_1', organizationId: 'org_1' }, data: { status: 'active' } }

  it('an email sequence resumes while EMAIL_ENABLED is exactly true (texting off)', async () => {
    switches('true', undefined)
    given(EMAIL_ONLY)
    const res = await patch('active')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'enr_1', updated: true })
    expect(db.sequenceEnrollment.updateMany).toHaveBeenCalledWith(resumed)
  })

  it('a text sequence resumes while SMS_ENABLED is exactly true (email off)', async () => {
    switches(undefined, 'true')
    given(SMS_ONLY)
    expect((await patch('active')).status).toBe(200)
    expect(db.sequenceEnrollment.updateMany).toHaveBeenCalledWith(resumed)
  })

  it('a mixed sequence resumes with both on', async () => {
    switches('true', 'true')
    given(MIXED)
    expect((await patch('active')).status).toBe(200)
    expect(writes()).toEqual(['sequenceEnrollment.updateMany'])
  })
})

describe('pause and unenroll stay allowed while everything is off', () => {
  it.each(['paused', 'cancelled'])('%s: saved, with no channel check', async (status) => {
    given(MIXED)
    const res = await patch(status)
    expect(res.status).toBe(200)
    expect(db.sequenceEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr_1', organizationId: 'org_1' },
      data: { status },
    })
    expect(db.sequenceEnrollment.findFirst).not.toHaveBeenCalled()
  })

  it('a bad status is still a 400, and nothing is written', async () => {
    const res = await patch('bogus')
    expect(res.status).toBe(400)
    expect(writes()).toEqual([])
  })
})

// updateEnrollment() is the one function that changes an enrollment's status:
// the route above, and so the Enrollment tab's Resume, go through it.
describe('updateEnrollment (the layer every status change goes through)', () => {
  it('refuses a resume while a channel is off, naming it, before anything is written', async () => {
    switches('true', undefined)
    given(MIXED)
    await expect(updateEnrollment('org_1', 'enr_1', { status: 'active' })).rejects.toMatchObject({
      code: 'sequence_channel_off',
      channels: ['sms'],
      message: "Texting is off, so this sequence can't start.",
    })
    expect(writes()).toEqual([])
  })

  it('resumes when every channel is on', async () => {
    switches('true', 'true')
    given(MIXED)
    await expect(updateEnrollment('org_1', 'enr_1', { status: 'active' })).resolves.toEqual({ count: 1 })
  })

  it("an id that isn't in this organization: nothing to check, and the org-scoped update matches nothing (as before)", async () => {
    db.sequenceEnrollment.findFirst.mockResolvedValue(null)
    db.sequenceEnrollment.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateEnrollment('org_1', 'enr_other', { status: 'active' })).resolves.toEqual({ count: 0 })
    expect(db.sequenceEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr_other', organizationId: 'org_1' },
      data: { status: 'active' },
    })
  })
})
