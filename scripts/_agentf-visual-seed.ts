import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { assertTestDatabase, scriptArgs } from '../src/lib/shared/db-guard'

/**
 * Agent F — throwaway visual-parity fixtures.
 *
 * Gives /leads, /leads/[id], /inbox, /sequences and /templates real content so
 * row density, message-row treatment and list styling can be compared against
 * Close. Everything created here is tagged and removed by `down`.
 *
 * Touches Lead / Contact / ContactEmail / ContactPhone / Message / EmailThread /
 * MessageTemplate / Sequence / SequenceStep ONLY — never OAuthCredential (fleet
 * landmine: upsertCredential keys on (org, provider) and would clobber Ryan's
 * real tokens in place).
 *
 * Dev-only. Tear down before running any gate: the e2e suite asserts exact row
 * counts and carries a residue check.
 */
// Brief 41 (H11) + 41.1: seeds and deletes fake fixture rows, so it only ever
// runs on a *_perf / *_test database. No --i-mean-live override.
assertTestDatabase(process.env.DATABASE_URL_MAIN, '_agentf-visual-seed (DATABASE_URL_MAIN)', { allowOverride: false })

const prisma = new PrismaClient()
const TAG = 'AGENT_F_VISUAL'

const LEADS: [string, string, number, string, string][] = [
  ['Marisol Okonkwo-Vance', 'Working', 92, 'hot', '1042 Ocean Pkwy, Brooklyn, NY 11230'],
  ['Devraj Balasubramanian', 'Working', 88, 'hot', '55 Wall St, Apt 22C, New York, NY 10005'],
  ['Priya Raghunathan', 'Potential', 74, 'warm', '30-15 Steinway St, Astoria, NY 11103'],
  ['Aleksandr Yevtushenko', 'Potential', 71, 'warm', '8722 Bay Pkwy, Brooklyn, NY 11214'],
  ['Fatoumata Diallo-Sow', 'Qualified', 69, 'warm', '215 W 92nd St, New York, NY 10025'],
  ['Ignacio Fuentes-Molina', 'Potential', 61, 'cold', '41-07 Bell Blvd, Bayside, NY 11361'],
  ['Wilhelmina Ashworth', 'Bad Fit', 44, 'cold', '175 Riverside Dr, New York, NY 10024'],
  ['Chidinma Adeyemi', 'Working', 83, 'hot', '9 Montague Ter, Brooklyn, NY 11201'],
  ['Bartholomew Kaczmarek', 'Potential', 57, 'cold', '2260 Cruger Ave, Bronx, NY 10467'],
  ['Suchitra Venkataraman', 'Qualified', 78, 'warm', '107-40 Queens Blvd, Forest Hills, NY 11375'],
  ['Oluwaseun Babatunde', 'Potential', 66, 'warm', '600 W 183rd St, New York, NY 10033'],
  ['Anneliese Brandtstetter', 'Working', 90, 'hot', '25 Sutton Pl S, New York, NY 10022'],
]

/** [channel, subject, body, unread, minutesAgo] */
const MESSAGES: [string, string, string, boolean, number][] = [
  ['email', 'Re: 25 Sutton Pl S — showing Saturday?', 'Hi Ryan, Saturday at 11 works for us. Should we bring the pre-approval letter, or is that only needed once we make an offer?', true, 14],
  ['email', 'Question about the Ocean Pkwy listing', 'We drove past last night. Is the parking deeded or is it a monthly rental from the building?', true, 52],
  ['sms', '', 'Running 10 min late to the 2pm — sorry! Still coming.', true, 96],
  ['email', 'Re: Comparable sales for 55 Wall', 'Thanks for pulling those. The 22C line looks like the closest match. Can you send the floor plan?', false, 240],
  ['voicemail', '', 'Voicemail (0:42) — caller asked about the Forest Hills two-bedroom and whether the sponsor pays transfer taxes.', false, 420],
  ['email', 'Offer submitted — 9 Montague Ter', 'Attaching the signed offer at asking with a 30-day close. Buyer is all cash, proof of funds included.', false, 1500],
  ['sms', '', 'Got it, thank you! We will review tonight and call you tomorrow.', false, 2880],
]

const TEMPLATES: [string, string, string | null, string][] = [
  ['Coming-soon heads-up', 'email', 'A quiet one before it hits the market', 'Hi {{first_name}},\n\nBefore this goes public I wanted you to see it: {{address}}, coming to market {{list_date}}.\n\nWorth a look this week?\n\n— Ryan'],
  ['Post-showing follow-up', 'email', 'Thoughts on {{address}}?', 'Hi {{first_name}},\n\nThanks for making time to see {{address}}. What stood out, and what missed?\n\nHappy to line up two or three more in the same band.\n\n— Ryan'],
  ['Price improvement', 'email', 'Price improved on {{address}}', 'Hi {{first_name}},\n\n{{address}} just came down to {{price}}. That puts it inside the range you gave me.\n\nWant to see it before the weekend?\n\n— Ryan'],
  ['Buyer ISO check-in', 'email', 'Still looking in {{neighborhood}}?', 'Hi {{first_name}},\n\nChecking in — are you still active in {{neighborhood}}, and has your range moved?\n\n— Ryan'],
  ['Showing confirmation', 'sms', null, 'Confirming {{time}} at {{address}}. Reply C to confirm or R to reschedule. — Ryan, Douglas Elliman'],
  ['Missed-call follow-up', 'sms', null, 'Hi {{first_name}}, Ryan at Douglas Elliman — sorry I missed you. Best number and time to reach you?'],
]

/** [name, channel, description, [[delayHours, channel]]] */
const SEQUENCES: [string, string, string, [number, string][]][] = [
  ['New buyer ISO — first week', 'email', 'Four touches over seven days for a fresh buyer inquiry.', [[0, 'email'], [48, 'email'], [96, 'sms'], [168, 'email']]],
  ['Coming-soon blast', 'email', 'Two-touch heads-up to the matched buyer list before a listing goes live.', [[0, 'email'], [72, 'email']]],
  ['Expired / withdrawn outreach', 'email', 'Slow five-touch cadence for expired listings.', [[0, 'email'], [120, 'email'], [240, 'sms'], [408, 'email'], [672, 'email']]],
  ['Open-house no-show', 'sms', 'Same-day nudge for registrants who did not attend.', [[4, 'sms'], [48, 'email']]],
]

async function up() {
  const org = await prisma.organization.findFirst({ where: { slug: 'dealflow-ryan' } })
  if (!org) throw new Error("org 'dealflow-ryan' not found — run `pnpm seed:main` first")

  if ((await prisma.lead.count({ where: { organizationId: org.id, source: TAG } })) > 0) {
    console.log('agentf-visual-seed: fixtures already present, nothing to do')
    return
  }

  const leadIds: string[] = []
  for (const [displayName, statusLabel, priorityScore, captureStatus, addr] of LEADS) {
    const lead = await prisma.lead.create({
      data: {
        organizationId: org.id,
        displayName,
        name: displayName,
        source: TAG,
        statusLabel,
        priorityScore,
        captureStatus,
        primaryAddressFull: addr,
        primaryAddressSummary: addr.split(',').slice(-2).join(',').trim(),
        matchReason: 'Seeded by Agent F for visual parity comparison.',
      },
    })
    leadIds.push(lead.id)
    const contact = await prisma.contact.create({
      data: { organizationId: org.id, leadId: lead.id, displayName, name: displayName, title: 'Owner' },
    })
    const slug = displayName.toLowerCase().replace(/[^a-z]+/g, '.')
    await prisma.contactEmail.create({ data: { contactId: contact.id, email: `${slug}@example.com`, type: 'office' } })
    await prisma.contactPhone.create({
      data: { contactId: contact.id, phone: `+1516555${String(1000 + leadIds.length).slice(-4)}`, type: 'mobile' },
    })
  }

  // Inbound messages so /inbox has real rows (read + unread, three channels).
  for (let i = 0; i < MESSAGES.length; i++) {
    const [channel, subject, body, unread, minutesAgo] = MESSAGES[i]
    const at = new Date(Date.now() - minutesAgo * 60_000)
    const leadId = leadIds[i % leadIds.length]
    const from = `${LEADS[i % LEADS.length][0].toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`
    const thread = await prisma.emailThread.create({
      data: {
        organizationId: org.id,
        leadId,
        subject: subject || '(no subject)',
        participants: [from, 'ryan@example.com'],
        messageCount: 1,
        firstMessageAt: at,
        lastMessageAt: at,
      },
    })
    await prisma.message.create({
      data: {
        organizationId: org.id,
        leadId,
        channel,
        direction: 'inbound',
        status: 'sent',
        threadId: thread.id,
        fromAddress: channel === 'email' ? from : '+15165550100',
        toAddresses: [channel === 'email' ? 'ryan@example.com' : '+15165551234'],
        subject: subject || null,
        bodyText: body,
        smsRemotePhone: channel === 'email' ? null : '+15165550100',
        readAt: unread ? null : at,
        activityAt: at,
        dateSent: at,
      },
    })
  }

  const templateIds: Record<string, string> = {}
  for (const [name, channel, subject, bodyText] of TEMPLATES) {
    const t = await prisma.messageTemplate.create({
      data: {
        organizationId: org.id,
        name: `${name} ${TAG}`,
        channel,
        subject,
        bodyText,
        mergeFields: [...bodyText.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]),
      },
    })
    templateIds[channel] = t.id
  }

  for (const [name, channel, description, steps] of SEQUENCES) {
    const seq = await prisma.sequence.create({
      data: { organizationId: org.id, name: `${name} ${TAG}`, channel, description },
    })
    for (let i = 0; i < steps.length; i++) {
      const [delayHours, stepChannel] = steps[i]
      await prisma.sequenceStep.create({
        data: {
          sequenceId: seq.id,
          ordinal: i,
          delayHours,
          channel: stepChannel,
          templateId: templateIds[stepChannel] ?? Object.values(templateIds)[0],
        },
      })
    }
  }

  console.log(
    `agentf-visual-seed: ${LEADS.length} leads, ${MESSAGES.length} messages, ` +
      `${TEMPLATES.length} templates, ${SEQUENCES.length} sequences`,
  )
}

async function down() {
  const org = await prisma.organization.findFirst({ where: { slug: 'dealflow-ryan' } })
  if (!org) return
  const leads = await prisma.lead.findMany({ where: { organizationId: org.id, source: TAG }, select: { id: true } })
  const leadIds = leads.map((l) => l.id)

  const msgs = await prisma.message.deleteMany({ where: { leadId: { in: leadIds } } })
  const threads = await prisma.emailThread.deleteMany({ where: { leadId: { in: leadIds } } })
  // Steps cascade from Sequence; delete the parents by tag.
  const seqs = await prisma.sequence.deleteMany({ where: { organizationId: org.id, name: { contains: TAG } } })
  const tpls = await prisma.messageTemplate.deleteMany({ where: { organizationId: org.id, name: { contains: TAG } } })
  const rmLeads = await prisma.lead.deleteMany({ where: { organizationId: org.id, source: TAG } })

  console.log(
    `agentf-visual-seed: removed ${rmLeads.count} leads, ${msgs.count} messages, ` +
      `${threads.count} threads, ${tpls.count} templates, ${seqs.count} sequences`,
  )
}

// Brief 41: the command must be given: anything but up/down (including
// nothing) is refused, so a slip never seeds. (A stray --i-mean-live is
// skipped when reading it; it unlocks nothing.)
const cmd = scriptArgs()[0]
if (cmd !== 'up' && cmd !== 'down') {
  console.error(`usage: _agentf-visual-seed.ts up|down (got ${cmd ? `"${cmd}"` : 'nothing'})`)
  process.exit(1)
}
void (cmd === 'down' ? down() : up())
  .catch((e) => {
    console.error('agentf-visual-seed failed:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
