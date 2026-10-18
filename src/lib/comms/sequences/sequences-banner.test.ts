import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Brief 41.2 (PR E): the /sequences banner. While email and texting are both
// off, active enrollments send nothing, but they would start firing once either
// switch goes on (audit H15), so the page says how many people are enrolled.
// "People" are distinct contacts with an active enrollment. The count only
// reads. The switches are set only in this test's own process.
const db: any = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
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
    message: model(),
    contact: model(),
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  }
})
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import SequencesPage from '@/app/sequences/page'

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

/** One sequence; `people` = the contacts with an active enrollment. */
function given(people: string[]) {
  db.sequence.findMany.mockResolvedValue([
    {
      id: 'seq_1',
      organizationId: 'org_1',
      name: 'New seller follow-up',
      description: null,
      channel: 'email',
      blackoutDates: [],
      createdAt: new Date('2026-10-01T12:00:00Z'),
      steps: [],
    },
  ])
  db.sequenceEnrollment.groupBy.mockImplementation(async (args: any) => {
    const by = args.by.join(',')
    if (by === 'contactId') return people.map((contactId) => ({ contactId }))
    if (by === 'sequenceId,status') {
      return people.length ? [{ sequenceId: 'seq_1', status: 'active', _count: { _all: people.length } }] : []
    }
    if (by === 'sequenceId') return [{ sequenceId: 'seq_1', _max: { enrolledAt: new Date('2026-10-02T12:00:00Z') } }]
    throw new Error(`unexpected groupBy by ${by}`)
  })
  db.message.groupBy.mockResolvedValue([])
}

async function render(): Promise<{ html: string; text: string }> {
  const html = renderToStaticMarkup(await SequencesPage())
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
  return { html, text }
}

const SWITCHES = ['EMAIL_ENABLED', 'SMS_ENABLED'] as const
const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]))
function set(name: (typeof SWITCHES)[number], value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of SWITCHES) set(k, undefined)
})
afterAll(() => {
  for (const k of SWITCHES) set(k, saved[k])
})

describe('/sequences banner while email and texting are off', () => {
  it('nobody enrolled: no banner', async () => {
    given([])
    const { html, text } = await render()
    expect(text).not.toContain('enrolled in sequences')
    expect(html).not.toContain('role="status"')
  })

  it('one person: "1 person is enrolled"', async () => {
    given(['c_1'])
    const { html, text } = await render()
    expect(text).toContain(
      '1 person is enrolled in sequences. Nothing sends while email and texting are off. Review them before switching either on.',
    )
    expect(html).toContain('role="status"')
  })

  it('three people: "3 people are enrolled"', async () => {
    given(['c_1', 'c_2', 'c_3'])
    const { text } = await render()
    expect(text).toContain(
      '3 people are enrolled in sequences. Nothing sends while email and texting are off. Review them before switching either on.',
    )
  })

  it('counts people, not enrollments: distinct contacts with an active enrollment in this organization', async () => {
    given(['c_1', 'c_2'])
    await render()
    expect(db.sequenceEnrollment.groupBy).toHaveBeenCalledWith({
      by: ['contactId'],
      where: { organizationId: 'org_1', status: 'active' },
    })
  })

  it('the count only reads: nothing is written', async () => {
    given(['c_1', 'c_2', 'c_3'])
    await render()
    expect(writes()).toEqual([])
  })
})

describe('/sequences banner with a switch on', () => {
  // The sentence says nothing sends, which is no longer true once either
  // switch is on, so the banner shows only while both are off.
  it.each(SWITCHES)('%s=true: no banner', async (name) => {
    set(name, 'true')
    given(['c_1', 'c_2', 'c_3'])
    const { text } = await render()
    expect(text).not.toContain('enrolled in sequences')
  })

  it.each(['TRUE', '1', ''])('EMAIL_ENABLED=%j still counts as off: the banner shows', async (value) => {
    set('EMAIL_ENABLED', value)
    given(['c_1'])
    const { text } = await render()
    expect(text).toContain('1 person is enrolled in sequences.')
  })
})
