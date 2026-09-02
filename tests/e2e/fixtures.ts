import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

/**
 * Fixtures for the E2E suite.
 *
 * Every spec that needs data creates it in `beforeAll` and deletes it in
 * `afterAll`. Before M5.1 the inbox and sequence specs relied on `[M3_SMOKE]` /
 * `[M4_SMOKE]` seeds that were deleted at the end of each milestone, so a later
 * run failed in a way that read as a regression rather than a missing
 * precondition (audit §13.13).
 *
 * Rules this module exists to enforce:
 *   - Everything created carries a spec-specific marker in a column we can
 *     filter on, so cleanup is exact and can be verified to zero.
 *   - NOTHING here writes OAuthCredential, or any other singleton keyed by
 *     (organizationId, X). A composite-unique upsert from a fixture is
 *     indistinguishable from a production write — that is how Agent D's Gmail
 *     token was destroyed in M3.
 *   - Cleanup runs first in `seed*` too, so a killed run cannot poison the next.
 */

// Playwright does not load .env on its own and does not resolve the `@/` alias
// in this (CommonJS) test context, hence the explicit dotenv import above and
// the direct @prisma/client import.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_MAIN } },
})

export const MARK_INBOX = '[E2E_INBOX]'
export const MARK_SEQ = '[E2E_SEQ]'
export const MARK_LEAD = '[E2E_LEAD]'

export async function disconnectFixtures(): Promise<void> {
  await prisma.$disconnect()
}

async function orgId(): Promise<string> {
  const org = await prisma.organization.findFirst({ where: { slug: 'dealflow-ryan' } })
  if (!org) {
    throw new Error(
      'E2E fixtures: organization "dealflow-ryan" is missing. Seed the Organization row first.',
    )
  }
  return org.id
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

/** Ids of the leads carrying a marker — resolved first, because rows that hang
 *  off a lead (an SMS message, a call) carry no marker of their own. */
async function markedLeadIds(mark: string): Promise<string[]> {
  const rows = await prisma.lead.findMany({ where: { source: mark }, select: { id: true } })
  return rows.map((r) => r.id)
}

async function removeLeadTree(org: string, mark: string): Promise<void> {
  const leadIds = await markedLeadIds(mark)
  const contacts = await prisma.contact.findMany({
    where: { leadId: { in: leadIds } },
    select: { id: true },
  })
  const contactIds = contacts.map((c) => c.id)

  // Order matters: enrollments reference contacts, messages/calls reference
  // leads, and ContactPhone hangs off contacts.
  await prisma.sequenceEnrollment.deleteMany({
    where: { organizationId: org, contactId: { in: contactIds } },
  })
  await prisma.message.deleteMany({ where: { organizationId: org, leadId: { in: leadIds } } })
  await prisma.call.deleteMany({ where: { organizationId: org, leadId: { in: leadIds } } })
  await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } })
  await prisma.contactPhone.deleteMany({ where: { contactId: { in: contactIds } } })
  await prisma.contact.deleteMany({ where: { leadId: { in: leadIds } } })
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } })
}

/* ------------------------------------------------------------------ inbox -- */

export interface InboxFixture {
  leadIds: string[]
  /** Thread count the inbox should list. */
  threadCount: number
}

/**
 * Four threads: a 3-message email exchange, a single unread email, an SMS
 * conversation, and a voicemail — the shapes the unified inbox has to merge.
 * Mirrors the retired [M3_SMOKE] seed exactly, so the assertions in
 * m3-inbox.spec.ts are unchanged.
 */
export async function seedInbox(): Promise<InboxFixture> {
  const org = await orgId()
  await cleanInbox()

  const people = [
    { name: 'Dana Whitfield', email: 'e2e-inbox-dana@example.com', phone: '+12125550101' },
    { name: 'Marcus Oyelaran', email: 'e2e-inbox-marcus@example.com', phone: '+12125550102' },
    { name: 'Priya Raghunathan', email: 'e2e-inbox-priya@example.com', phone: '+12125550103' },
  ]

  const leadIds: string[] = []
  const contactIds: string[] = []
  for (const p of people) {
    const lead = await prisma.lead.create({
      data: {
        organizationId: org,
        displayName: p.name,
        source: MARK_INBOX,
        timezone: 'America/New_York',
        statusLabel: 'Working',
      },
    })
    leadIds.push(lead.id)
    const contact = await prisma.contact.create({
      data: {
        organizationId: org,
        leadId: lead.id,
        displayName: p.name,
        name: p.name,
        timezone: 'America/New_York',
        phones: {
          create: { phone: p.phone, phoneFormatted: p.phone, type: 'mobile', isPrimary: true },
        },
      },
    })
    contactIds.push(contact.id)
  }

  const message = (over: Record<string, unknown>) =>
    prisma.message.create({
      data: {
        organizationId: org,
        channel: 'email',
        status: 'sent',
        toAddresses: ['ryan@example.com'],
        ...over,
      } as never,
    })

  // Thread A — three messages, newest incoming and unread.
  await message({
    leadId: leadIds[0],
    contactId: contactIds[0],
    threadId: 'e2e_inbox_a',
    direction: 'incoming',
    fromAddress: people[0].email,
    subject: '412 W 22nd walkthrough',
    bodyText: 'Hi Ryan — is Thursday still good for the walkthrough?',
    activityAt: hoursAgo(30),
  })
  await message({
    leadId: leadIds[0],
    contactId: contactIds[0],
    threadId: 'e2e_inbox_a',
    direction: 'outgoing',
    fromAddress: 'ryan@example.com',
    toAddresses: [people[0].email],
    subject: '412 W 22nd walkthrough',
    bodyText: 'Thursday works. 2pm at the building?',
    activityAt: hoursAgo(28),
    readAt: hoursAgo(28),
  })
  await message({
    leadId: leadIds[0],
    contactId: contactIds[0],
    threadId: 'e2e_inbox_a',
    direction: 'incoming',
    fromAddress: people[0].email,
    subject: '412 W 22nd walkthrough',
    bodyText: 'Perfect, see you at 2. I will bring my partner.',
    activityAt: hoursAgo(2),
  })

  // Thread B — one unread email.
  await message({
    leadId: leadIds[1],
    contactId: contactIds[1],
    direction: 'incoming',
    fromAddress: people[1].email,
    subject: 'Sullivan St comps',
    bodyText: 'What did the last comparable on the block trade at?',
    activityAt: hoursAgo(5),
  })

  // Thread C — SMS, which the reply drawer must refuse to send from.
  await message({
    leadId: leadIds[2],
    contactId: contactIds[2],
    threadId: 'e2e_inbox_c',
    channel: 'sms',
    direction: 'incoming',
    fromAddress: people[2].phone,
    smsRemotePhone: people[2].phone,
    subject: null,
    bodyText: 'Can you text me the open house time?',
    activityAt: hoursAgo(4),
  })

  // Thread D — voicemail. The spec asserts the "24s" duration label.
  await prisma.call.create({
    data: {
      organizationId: org,
      leadId: leadIds[1],
      contactId: contactIds[1],
      direction: 'inbound',
      callMethod: 'power',
      status: 'completed',
      disposition: 'vm-left',
      localPhone: '+12125550000',
      remotePhone: people[1].phone,
      providerCallSid: `CA_E2E_INBOX_${Date.now()}`,
      voicemailUrl: 'https://example.com/vm/e2e-inbox.mp3',
      voicemailDurationSec: 24,
      activityAt: hoursAgo(6),
    },
  })

  // The reply drawer's template picker needs at least one email template.
  await prisma.messageTemplate.create({
    data: {
      organizationId: org,
      name: `${MARK_INBOX} Showing follow-up`,
      channel: 'email',
      subject: 'Following up on your showing',
      bodyText: 'Hi — thanks for touring the unit. Happy to answer any questions.',
      mergeFields: [],
    },
  })

  return { leadIds, threadCount: 4 }
}

export async function cleanInbox(): Promise<void> {
  const org = await orgId()
  await removeLeadTree(org, MARK_INBOX)
  await prisma.messageTemplate.deleteMany({
    where: { organizationId: org, name: { startsWith: MARK_INBOX } },
  })
  // Replies the send case files onto a fixture thread are caught by the lead
  // sweep above; this catches any that were created without a lead.
  await prisma.message.deleteMany({
    where: { organizationId: org, threadId: { startsWith: 'e2e_inbox_' } },
  })
}

/* -------------------------------------------------------------- sequences -- */

/**
 * One lead with one contact — the enrollment target. Templates and sequences
 * are deliberately NOT seeded: creating them through the UI is the milestone's
 * acceptance criterion.
 */
export async function seedSequenceLead(): Promise<{ leadId: string; displayName: string }> {
  const org = await orgId()
  await cleanSequences()

  const displayName = 'Dana Whitfield'
  const lead = await prisma.lead.create({
    data: {
      organizationId: org,
      displayName,
      source: MARK_SEQ,
      timezone: 'America/New_York',
      statusLabel: 'Working',
    },
  })
  await prisma.contact.create({
    data: {
      organizationId: org,
      leadId: lead.id,
      displayName,
      name: displayName,
      timezone: 'America/New_York',
      phones: {
        create: { phone: '+12125550101', phoneFormatted: '+12125550101', type: 'mobile', isPrimary: true },
      },
    },
  })
  return { leadId: lead.id, displayName }
}

/** Also removes the templates and sequences the spec builds through the UI. */
export async function cleanSequences(): Promise<void> {
  const org = await orgId()
  await removeLeadTree(org, MARK_SEQ)
  await prisma.sequence.deleteMany({
    where: { organizationId: org, name: { startsWith: '[M4_SMOKE]' } },
  })
  await prisma.messageTemplate.deleteMany({
    where: { organizationId: org, name: { startsWith: '[M4_SMOKE]' } },
  })
}

/* ------------------------------------------------------------------- lead -- */

/** A single lead + contact, for specs that only need the detail page to exist. */
export async function seedLead(displayName = 'Avery Lindqvist'): Promise<{ leadId: string; displayName: string }> {
  const org = await orgId()
  await cleanLead()

  const lead = await prisma.lead.create({
    data: {
      organizationId: org,
      displayName,
      source: MARK_LEAD,
      timezone: 'America/New_York',
      statusLabel: 'Working',
    },
  })
  await prisma.contact.create({
    data: {
      organizationId: org,
      leadId: lead.id,
      displayName,
      name: displayName,
      timezone: 'America/New_York',
      phones: {
        create: { phone: '+12125550190', phoneFormatted: '+12125550190', type: 'mobile', isPrimary: true },
      },
    },
  })
  return { leadId: lead.id, displayName }
}

export async function cleanLead(): Promise<void> {
  await removeLeadTree(await orgId(), MARK_LEAD)
}

/* --------------------------------------------------------------- importer -- */

/**
 * The importer spec creates its own rows by uploading a CSV, but never removed
 * them — a successful run left 500 leads behind and the NEXT run was no longer
 * starting from a clean database.
 */
export async function cleanImportedLeads(): Promise<void> {
  const org = await orgId()
  const leads = await prisma.lead.findMany({
    where: { organizationId: org, source: { startsWith: 'import:' } },
    select: { id: true },
  })
  const leadIds = leads.map((l) => l.id)
  if (leadIds.length === 0) return

  const contacts = await prisma.contact.findMany({
    where: { leadId: { in: leadIds } },
    select: { id: true },
  })
  const contactIds = contacts.map((c) => c.id)
  await prisma.contactPhone.deleteMany({ where: { contactId: { in: contactIds } } })
  await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } })
  await prisma.contact.deleteMany({ where: { leadId: { in: leadIds } } })
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } })
}

/* -------------------------------------------------------------- residue --- */

/** Counts of everything the fixtures can create. Every value must be 0 after
 *  cleanup — asserted by tests/e2e/fixtures-residue.spec.ts. */
export async function fixtureResidue(): Promise<Record<string, number>> {
  const org = await orgId()
  return {
    inboxLeads: await prisma.lead.count({ where: { source: MARK_INBOX } }),
    sequenceLeads: await prisma.lead.count({ where: { source: MARK_SEQ } }),
    leadFixtures: await prisma.lead.count({ where: { source: MARK_LEAD } }),
    importedLeads: await prisma.lead.count({
      where: { organizationId: org, source: { startsWith: 'import:' } },
    }),
    fixtureThreads: await prisma.message.count({
      where: { organizationId: org, threadId: { startsWith: 'e2e_inbox_' } },
    }),
    fixtureTemplates: await prisma.messageTemplate.count({
      where: { organizationId: org, OR: [{ name: { startsWith: MARK_INBOX } }, { name: { startsWith: '[M4_SMOKE]' } }] },
    }),
  }
}
