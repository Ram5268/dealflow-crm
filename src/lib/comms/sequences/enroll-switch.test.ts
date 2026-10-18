import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Brief 41.2 (PR E): no new sequence enrollment while a channel the sequence
// uses is off. Email steps need EMAIL_ENABLED, text steps need SMS_ENABLED, and
// each is on only when exactly 'true'. Engineering precaution (audit H15): an
// enrollment made while a switch is off stays active, and once the switch goes
// on the tick fires every overdue step at once. The refusal comes before
// anything is written. The switches are set only in this test's own process.
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
    contact: model(),
    sequenceEnrollment: model(),
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  }
})
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import { POST } from '@/app/api/comms/enrollments/route'
import { enrollContact } from './crud'

const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']
/** Every write the code under test made, as `model.method`. */
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

const step = (id: string, ordinal: number, channel: string) => ({
  id,
  sequenceId: 'seq_1',
  ordinal,
  delayHours: 24 * (ordinal - 1),
  channel,
  templateId: `tpl_${id}`,
})
const sequence = (channel: string, steps: ReturnType<typeof step>[]) => ({
  id: 'seq_1',
  organizationId: 'org_1',
  name: 'New seller follow-up',
  description: null,
  channel,
  blackoutDates: [],
  steps,
})
const EMAIL_ONLY = sequence('email', [step('st1', 1, 'email'), step('st2', 2, 'email')])
const SMS_ONLY = sequence('sms', [step('st1', 1, 'sms')])
const MIXED = sequence('mixed', [step('st1', 1, 'email'), step('st2', 2, 'sms')])

function given(seq: unknown) {
  db.sequence.findFirst.mockResolvedValue(seq)
  db.contact.findFirst.mockResolvedValue({ id: 'c_1', organizationId: 'org_1' })
  db.sequenceEnrollment.findFirst.mockResolvedValue(null)
  db.sequenceEnrollment.create.mockImplementation(async (a: any) => ({ id: 'enr_1', ...a.data }))
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

const enroll = { sequenceId: 'seq_1', contactId: 'c_1' }
const post = (body: unknown) =>
  new Request('http://crm.test/api/comms/enrollments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function refused(res: Response, message: string, channels: string[]) {
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'sequence_channel_off', message, channels })
  expect(writes()).toEqual([])
  // Refused before the contact or duplicate lookups, let alone the insert.
  expect(db.contact.findFirst).not.toHaveBeenCalled()
  expect(db.sequenceEnrollment.findFirst).not.toHaveBeenCalled()
}

describe('POST /api/comms/enrollments while a channel the sequence uses is off', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', ' true'])(
    'an email sequence is refused while EMAIL_ENABLED is %j (texting on does not help)',
    async (value) => {
      switches(value, 'true')
      given(EMAIL_ONLY)
      await refused(await POST(post(enroll)), "Email is off, so this sequence can't start.", ['email'])
    },
  )

  it('an email sequence is refused while both are off (today)', async () => {
    given(EMAIL_ONLY)
    await refused(await POST(post(enroll)), "Email is off, so this sequence can't start.", ['email'])
  })

  it.each([undefined, '', 'TRUE', '1'])('a text sequence is refused while SMS_ENABLED is %j', async (value) => {
    switches('true', value)
    given(SMS_ONLY)
    await refused(await POST(post(enroll)), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it('a mixed sequence needs both: refused with texting off', async () => {
    switches('true', undefined)
    given(MIXED)
    await refused(await POST(post(enroll)), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it('a mixed sequence needs both: refused with email off', async () => {
    switches(undefined, 'true')
    given(MIXED)
    await refused(await POST(post(enroll)), "Email is off, so this sequence can't start.", ['email'])
  })

  it('a mixed sequence with both off names both', async () => {
    given(MIXED)
    await refused(await POST(post(enroll)), "Email and texting are off, so this sequence can't start.", ['email', 'sms'])
  })

  it("a step's channel counts even when the sequence is labelled email", async () => {
    switches('true', undefined)
    given(sequence('email', [step('st1', 1, 'email'), step('st2', 2, 'sms')]))
    await refused(await POST(post(enroll)), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it("the sequence's own channel counts too: a mixed sequence with only email steps so far", async () => {
    switches('true', undefined)
    given(sequence('mixed', [step('st1', 1, 'email')]))
    await refused(await POST(post(enroll)), "Texting is off, so this sequence can't start.", ['sms'])
  })

  it('a sequence with no steps yet still needs its own channel', async () => {
    given(sequence('email', []))
    await refused(await POST(post(enroll)), "Email is off, so this sequence can't start.", ['email'])
  })

  it("a channel the CRM can't send counts as off, even with both switches on", async () => {
    switches('true', 'true')
    given(sequence('email', [step('st1', 1, 'email'), step('st2', 2, 'voice')]))
    await refused(
      await POST(post(enroll)),
      "This sequence uses a channel the CRM can't send, so it can't start.",
      ['voice'],
    )
  })
})

describe('POST /api/comms/enrollments with every channel it uses on (mocked)', () => {
  const created = () => ({
    data: { organizationId: 'org_1', sequenceId: 'seq_1', contactId: 'c_1', status: 'active', currentStepId: 'st1' },
  })

  it('an email sequence enrolls while EMAIL_ENABLED is exactly true (texting off)', async () => {
    switches('true', undefined)
    given(EMAIL_ONLY)
    const res = await POST(post(enroll))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ enrollmentId: 'enr_1', currentStepId: 'st1', status: 'active' })
    expect(db.sequenceEnrollment.create).toHaveBeenCalledWith(created())
  })

  it('a text sequence enrolls while SMS_ENABLED is exactly true (email off)', async () => {
    switches(undefined, 'true')
    given(SMS_ONLY)
    expect((await POST(post(enroll))).status).toBe(201)
    expect(db.sequenceEnrollment.create).toHaveBeenCalledWith(created())
  })

  it('a mixed sequence enrolls with both on', async () => {
    switches('true', 'true')
    given(MIXED)
    expect((await POST(post(enroll))).status).toBe(201)
    expect(writes()).toEqual(['sequenceEnrollment.create'])
  })

  it('an unknown sequence is still a 404, and nothing is written', async () => {
    db.sequence.findFirst.mockResolvedValue(null)
    const res = await POST(post(enroll))
    expect(res.status).toBe(404)
    expect(writes()).toEqual([])
  })

  it('a duplicate is still a 409 with the channel on', async () => {
    switches('true', undefined)
    given(EMAIL_ONLY)
    db.sequenceEnrollment.findFirst.mockResolvedValue({ id: 'existing' })
    const res = await POST(post(enroll))
    expect(res.status).toBe(409)
    expect(writes()).toEqual([])
  })
})

// enrollContact() is the one function that creates an enrollment: the route
// above, and so the lead page's "Add to sequence", go through it. Anything that
// calls it later gets the same refusal.
describe('enrollContact (the layer every enrollment goes through)', () => {
  it('refuses while a channel is off, naming it, before anything is written', async () => {
    switches('true', undefined)
    given(MIXED)
    await expect(enrollContact('org_1', enroll)).rejects.toMatchObject({
      code: 'sequence_channel_off',
      channels: ['sms'],
      message: "Texting is off, so this sequence can't start.",
    })
    expect(writes()).toEqual([])
  })

  it('enrolls at the first step when every channel is on', async () => {
    switches('true', 'true')
    given(MIXED)
    const enrollment = await enrollContact('org_1', enroll)
    expect(enrollment).toMatchObject({ id: 'enr_1', status: 'active', currentStepId: 'st1' })
  })
})
