import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// Perf seed — 25k Lead + ~28k Contact + ~40k ContactPhone + 10 custom field
// definitions + ~50k CustomFieldValue into the DEDICATED perf DB.
//
// HARD GUARDRAIL: refuses to run unless DATABASE_URL_PERF ends in `_perf`, so it
// can never pollute Ryan's dev/main DB or hit localhost by accident.
//
// Bulk-inserts via createMany in chunks (sequential .create over Railway is
// ~90ms/row — 135k rows would take ~3.5h). Ids are generated deterministically
// so CustomFieldValue can reference lead ids without a round-trip.
// ─────────────────────────────────────────────────────────────────────────────

const PERF_URL = process.env.DATABASE_URL_PERF
const PERF_DB_NAME = PERF_URL
  ? new URL(PERF_URL).pathname.replace(/^\//, '').split('?')[0]
  : '(unset)'
if (!PERF_URL || !PERF_DB_NAME.endsWith('_perf')) {
  console.error(
    `REFUSING TO SEED: DATABASE_URL_PERF database name is "${PERF_DB_NAME}", must end with "_perf".`
  )
  process.exit(1)
}

const ORG_ID = 'org_perf'
const USER_ID = 'user_perf'
const TOTAL_LEADS = 25_000
const CHUNK = 2_000

const STATUSES = ['Hot', 'Warm', 'Cold', 'New', 'Nurture', null]
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', null]
const PHONE_TYPES = ['mobile', 'office', 'home', 'direct']
const CUSTOM_DEFS = Array.from({ length: 10 }, (_, i) => ({
  id: `cf_seed_${i}`,
  organizationId: ORG_ID,
  objectType: 'lead',
  name: `Custom ${i}`,
  type: i % 3 === 0 ? 'number' : i % 3 === 1 ? 'text' : 'date',
  displayOrder: i,
}))

const prisma = new PrismaClient({
  datasources: { db: { url: PERF_URL } },
})

async function chunkedCreate<T>(
  label: string,
  rows: T[],
  create: (batch: T[]) => Promise<unknown>
) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await create(rows.slice(i, i + CHUNK))
    process.stdout.write(`\r  ${label}: ${Math.min(i + CHUNK, rows.length)}/${rows.length}   `)
  }
  process.stdout.write('\n')
}

async function main() {
  console.log(`Seeding perf DB: ${new URL(PERF_URL!).pathname}`)
  const start = Date.now()

  // Clean slate (idempotent re-seed).
  await prisma.customFieldValue.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.contactPhone.deleteMany({ where: { contact: { organizationId: ORG_ID } } })
  await prisma.contactEmail.deleteMany({ where: { contact: { organizationId: ORG_ID } } })
  await prisma.contact.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.customFieldValue.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.customFieldDefinition.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.lead.deleteMany({ where: { organizationId: ORG_ID } })
  await prisma.user.deleteMany({ where: { id: USER_ID } })
  await prisma.organization.deleteMany({ where: { id: ORG_ID } })

  await prisma.organization.create({
    data: { id: ORG_ID, slug: 'perf-org', name: 'Perf Org' },
  })
  await prisma.user.create({
    data: { id: USER_ID, organizationId: ORG_ID, email: 'perf@x.dev', displayName: 'Perf' },
  })
  await prisma.customFieldDefinition.createMany({ data: CUSTOM_DEFS, skipDuplicates: true })

  // Build lead rows.
  const leads: Array<Record<string, unknown>> = []
  const contacts: Array<Record<string, unknown>> = []
  const phones: Array<Record<string, unknown>> = []
  const values: Array<Record<string, unknown>> = []

  for (let i = 0; i < TOTAL_LEADS; i++) {
    const leadId = `ld_${i.toString().padStart(6, '0')}`
    const covered = i % 3 !== 0 // ~66% get a contact + phone (empirical coverage)
    const priority = i % 7 === 0 ? null : (i * 37) % 100
    leads.push({
      id: leadId,
      organizationId: ORG_ID,
      displayName: `Lead ${i}`,
      name: `Owner ${i}`,
      statusLabel: STATUSES[i % STATUSES.length],
      statusId: STATUSES[i % STATUSES.length] ? `st_${i % STATUSES.length}` : null,
      priorityScore: priority,
      topMatchFit: i % 5 === 0 ? null : (i * 13) % 100,
      captureStatus: ['EXTERNAL_BOTH', 'OWN_BUYER_ONLY', 'OWN_LISTING_ONLY', 'OWN_BOTH_SIDES'][i % 4],
      timezone: TIMEZONES[i % TIMEZONES.length],
      primaryAddressFull: `${100 + i} Main St, New York, NY 100${i % 100}`,
      primaryAddressSummary: `${100 + i} Main St`,
      mojoId: i % 2 === 0 ? `mojo_${i}` : null,
      source: i % 4 === 0 ? `import:batch_${i % 50}` : 'seed',
    })

    if (covered) {
      const contactCount = i % 2 === 0 ? 2 : 1
      for (let c = 0; c < contactCount; c++) {
        const contactId = `ct_${leadId}_${c}`
        contacts.push({
          id: contactId,
          organizationId: ORG_ID,
          leadId,
          displayName: `Contact ${i}-${c}`,
          name: `Owner ${i}-${c}`,
          title: c === 0 ? 'Owner' : 'Co-owner',
          timezone: TIMEZONES[i % TIMEZONES.length],
        })
        // Primary contact (c===0) gets 1-2 phones; secondary gets 1.
        const phoneCount = c === 0 && i % 3 === 1 ? 2 : 1
        for (let p = 0; p < phoneCount; p++) {
          phones.push({
            id: `ph_${contactId}_${p}`,
            contactId,
            phone: `+1212${(5550000 + i * 3 + c * 10 + p).toString().slice(-7)}`,
            type: PHONE_TYPES[(i + p) % PHONE_TYPES.length],
            isPrimary: c === 0 && p === 0,
            lineType: i % 4 === 0 ? 'mobile' : null,
          })
        }
      }
    }

    // 2 custom values per lead → ~50k total.
    for (let v = 0; v < 2; v++) {
      const def = CUSTOM_DEFS[(i + v) % CUSTOM_DEFS.length]
      values.push({
        id: `cfv_${leadId}_${v}`,
        organizationId: ORG_ID,
        definitionId: def.id,
        objectType: 'lead',
        objectId: leadId,
        valueNumber: def.type === 'number' ? (i * 11) % 5_000_000 : null,
        valueText: def.type === 'text' ? `note ${i}` : null,
        valueDate: def.type === 'date' ? new Date(2026, i % 12, (i % 27) + 1) : null,
      })
    }
  }

  await chunkedCreate('leads', leads, (b) => prisma.lead.createMany({ data: b as never, skipDuplicates: true }))
  await chunkedCreate('contacts', contacts, (b) => prisma.contact.createMany({ data: b as never, skipDuplicates: true }))
  await chunkedCreate('phones', phones, (b) => prisma.contactPhone.createMany({ data: b as never, skipDuplicates: true }))
  await chunkedCreate('values', values, (b) => prisma.customFieldValue.createMany({ data: b as never, skipDuplicates: true }))

  const [nl, nc, np, nv] = await Promise.all([
    prisma.lead.count({ where: { organizationId: ORG_ID } }),
    prisma.contact.count({ where: { organizationId: ORG_ID } }),
    prisma.contactPhone.count({ where: { contact: { organizationId: ORG_ID } } }),
    prisma.customFieldValue.count({ where: { organizationId: ORG_ID } }),
  ])
  console.log(
    `Seeded: ${nl} leads, ${nc} contacts, ${np} phones, ${nv} custom values ` +
      `in ${((Date.now() - start) / 1000).toFixed(1)}s`
  )
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('seed-dev failed:', err)
  await prisma.$disconnect()
  process.exit(1)
})
