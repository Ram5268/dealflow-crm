import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

/**
 * Agent F — throwaway visual-parity fixtures.
 *
 * Creates a handful of leads so /leads and /leads/[id] have real row density to
 * compare against Close. Every row is tagged source 'AGENT_F_VISUAL' and is
 * removed by `tsx scripts/_agentf-visual-seed.ts down`. Touches Lead / Contact /
 * ContactEmail / ContactPhone ONLY — never OAuthCredential (fleet landmine:
 * upsertCredential keys on (org, provider) and clobbers Ryan's real tokens).
 *
 * Not part of the shipped seed set; delete before the brief closes.
 */
const prisma = new PrismaClient()
const TAG = 'AGENT_F_VISUAL'

const ROWS: [string, string, number, string, string][] = [
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

async function up() {
  const org = await prisma.organization.findFirst({ where: { slug: 'dealflow-ryan' } })
  if (!org) throw new Error("org 'dealflow-ryan' not found — run `pnpm seed:main` first")

  const existing = await prisma.lead.count({ where: { organizationId: org.id, source: TAG } })
  if (existing > 0) {
    console.log(`agentf-visual-seed: ${existing} tagged leads already present, nothing to do`)
    return
  }

  let n = 0
  for (const [displayName, statusLabel, priorityScore, captureStatus, addr] of ROWS) {
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
    const contact = await prisma.contact.create({
      data: {
        organizationId: org.id,
        leadId: lead.id,
        displayName,
        name: displayName,
        title: 'Owner',
      },
    })
    const slug = displayName.toLowerCase().replace(/[^a-z]+/g, '.')
    await prisma.contactEmail.create({
      data: { contactId: contact.id, email: `${slug}@example.com`, type: 'office' },
    })
    await prisma.contactPhone.create({
      data: { contactId: contact.id, phone: `+1516555${String(1000 + n).slice(-4)}`, type: 'mobile' },
    })
    n++
  }
  console.log(`agentf-visual-seed: created ${n} leads tagged ${TAG}`)
}

async function down() {
  const { count } = await prisma.lead.deleteMany({ where: { source: TAG } })
  console.log(`agentf-visual-seed: removed ${count} leads tagged ${TAG}`)
}

const cmd = process.argv[2]
void (cmd === 'down' ? down() : up())
  .catch((e) => {
    console.error('agentf-visual-seed failed:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
