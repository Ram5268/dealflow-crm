import 'dotenv/config'
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { countPeopleInActiveSequences } from '@/lib/sequences/queries'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 41.2 (PR E): the /sequences banner's count on real Postgres, inside two
// throwaway organizations so no other suite's rows are touched. "People" are
// distinct contacts with an active enrollment in this organization: someone in
// two sequences counts once, and paused enrollments and other organizations'
// don't count. The count itself only reads.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN; skips when it's unset

const TAG = `b412e_${Date.now()}`

describe.runIf(enabled)('countPeopleInActiveSequences (real Postgres)', () => {
  const orgIds: string[] = []

  async function org(key: string): Promise<string> {
    const o = await prisma.organization.create({ data: { slug: `${TAG}_${key}`, name: `Brief 41.2 PR E ${key}` } })
    orgIds.push(o.id)
    return o.id
  }

  async function contact(organizationId: string, key: string): Promise<string> {
    const lead = await prisma.lead.create({
      data: {
        organizationId,
        displayName: `${TAG} ${key}`,
        contacts: { create: { organizationId, displayName: `${TAG} ${key}` } },
      },
      include: { contacts: true },
    })
    return lead.contacts[0].id
  }

  async function sequence(organizationId: string, key: string): Promise<string> {
    const s = await prisma.sequence.create({ data: { organizationId, name: `${TAG} ${key}`, channel: 'email' } })
    return s.id
  }

  const enroll = (organizationId: string, sequenceId: string, contactId: string, status: string) =>
    prisma.sequenceEnrollment.create({ data: { organizationId, sequenceId, contactId, status } })

  afterAll(async () => {
    if (orgIds.length > 0) {
      await prisma.sequenceEnrollment.deleteMany({ where: { organizationId: { in: orgIds } } })
      await prisma.sequence.deleteMany({ where: { organizationId: { in: orgIds } } }) // and their steps
      await prisma.lead.deleteMany({ where: { organizationId: { in: orgIds } } }) // and their contacts
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    }
  })

  it('2 people with 3 active enrollments across 2 sequences count as 2; a paused one and another organization\'s are left out', async () => {
    const a = await org('a')
    const b = await org('b')
    const [first, second, pausedOnly] = [await contact(a, 'first'), await contact(a, 'second'), await contact(a, 'paused')]
    const [s1, s2] = [await sequence(a, 's1'), await sequence(a, 's2')]

    await enroll(a, s1, first, 'active')
    await enroll(a, s2, first, 'active') // the same person in a second sequence counts once
    await enroll(a, s1, second, 'active')
    await enroll(a, s2, pausedOnly, 'paused') // paused: not counted
    await enroll(b, await sequence(b, 'sb'), await contact(b, 'other'), 'active') // another organization

    const before = await prisma.sequenceEnrollment.findMany({
      where: { organizationId: { in: orgIds } },
      orderBy: { id: 'asc' },
    })
    expect(before).toHaveLength(5)

    expect(await countPeopleInActiveSequences(a)).toBe(2)
    expect(await countPeopleInActiveSequences(b)).toBe(1)

    // Read-only: every enrollment is exactly as it was.
    const after = await prisma.sequenceEnrollment.findMany({
      where: { organizationId: { in: orgIds } },
      orderBy: { id: 'asc' },
    })
    expect(after).toEqual(before)
  })

  it('an organization with nobody enrolled counts 0', async () => {
    expect(await countPeopleInActiveSequences(await org('empty'))).toBe(0)
  })
})
