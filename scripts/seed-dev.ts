import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { assertTestDatabase } from '../src/lib/shared/db-guard'

// ─────────────────────────────────────────────────────────────────────────────
// Perf seed — 25k Lead + ~25k Contact + ~33k ContactPhone + 10 custom field
// definitions + 50k CustomFieldValue.
//
// Brief 50 (6.14): tests/perf/25k.test.ts seeds this itself (seedPerf) into its
// own schema of the suite's test database, so the speed test never depends on
// a hand-seeded database. Run as a script, it seeds org_perf into
// DATABASE_URL_PERF as before.
//
// HARD GUARDRAIL (script): refuses to run unless DATABASE_URL_PERF ends in
// `_perf`, so it can never pollute Ryan's dev/main DB or hit localhost by accident.
//
// Made-up data only (Brief 50, engineering precaution): "Lead N" / "Owner N",
// fictional streets ("N Example St"), and phone numbers only in the fictional
// 555-0100..0199 range (they repeat across leads; that's fine).
//
// Bulk-inserts via createMany in chunks (sequential .create over Railway is
// ~90ms/row — 135k rows would take ~3.5h). Ids are generated deterministically
// so CustomFieldValue can reference lead ids without a round-trip.
// ─────────────────────────────────────────────────────────────────────────────

export const PERF_ORG_ID = 'org_perf'
const USER_ID = 'user_perf'
export const PERF_TOTAL_LEADS = 25_000
const CHUNK = 2_000

const STATUSES = ['Hot', 'Warm', 'Cold', 'New', 'Nurture', null]
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', null]
const PHONE_TYPES = ['mobile', 'office', 'home', 'direct']
const CUSTOM_DEFS = Array.from({ length: 10 }, (_, i) => ({
  id: `cf_seed_${i}`,
  organizationId: PERF_ORG_ID,
  objectType: 'lead',
  name: `Custom ${i}`,
  type: i % 3 === 0 ? 'number' : i % 3 === 1 ? 'text' : 'date',
  displayOrder: i,
}))

// A fictional number: +1 212 555-01xx.
const fictionalPhone = (n: number) => `+121255501${String(n % 100).padStart(2, '0')}`

export function buildPerfRows(total = PERF_TOTAL_LEADS) {
  const leads = []
  const contacts = []
  const phones = []
  const values = []

  for (let i = 0; i < total; i++) {
    const leadId = `ld_${i.toString().padStart(6, '0')}`
    const covered = i % 3 !== 0 // ~66% get a contact + phone (empirical coverage)
    const priority = i % 7 === 0 ? null : (i * 37) % 100
    leads.push({
      id: leadId,
      organizationId: PERF_ORG_ID,
      displayName: `Lead ${i}`,
      name: `Owner ${i}`,
      statusLabel: STATUSES[i % STATUSES.length],
      statusId: STATUSES[i % STATUSES.length] ? `st_${i % STATUSES.length}` : null,
      priorityScore: priority,
      topMatchFit: i % 5 === 0 ? null : (i * 13) % 100,
      captureStatus: ['EXTERNAL_BOTH', 'OWN_BUYER_ONLY', 'OWN_LISTING_ONLY', 'OWN_BOTH_SIDES'][i % 4],
      timezone: TIMEZONES[i % TIMEZONES.length],
      primaryAddressFull: `${100 + i} Example St, New York, NY 100${i % 100}`,
      primaryAddressSummary: `${100 + i} Example St`,
      mojoId: i % 2 === 0 ? `mojo_${i}` : null,
      source: i % 4 === 0 ? `import:batch_${i % 50}` : 'seed',
    })

    if (covered) {
      const contactCount = i % 2 === 0 ? 2 : 1
      for (let c = 0; c < contactCount; c++) {
        const contactId = `ct_${leadId}_${c}`
        contacts.push({
          id: contactId,
          organizationId: PERF_ORG_ID,
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
            phone: fictionalPhone(i * 3 + c * 10 + p),
            type: PHONE_TYPES[(i + p) % PHONE_TYPES.length],
            isPrimary: c === 0 && p === 0,
            lineType: i % 4 === 0 ? 'mobile' : null,
          })
        }
      }
    }

    // 2 custom values per lead → 50k total.
    for (let v = 0; v < 2; v++) {
      const def = CUSTOM_DEFS[(i + v) % CUSTOM_DEFS.length]
      values.push({
        id: `cfv_${leadId}_${v}`,
        organizationId: PERF_ORG_ID,
        definitionId: def.id,
        objectType: 'lead',
        objectId: leadId,
        // Brief 50: spread over 0..5M (was (i * 11), which never reached the
        // speed test's "custom number >= 1M" query, so it timed an empty result).
        valueNumber: def.type === 'number' ? (i * 211) % 5_000_000 : null,
        valueText: def.type === 'text' ? `note ${i}` : null,
        valueDate: def.type === 'date' ? new Date(2026, i % 12, (i % 27) + 1) : null,
      })
    }
  }

  return { leads, contacts, phones, values }
}

type Retry = <T>(what: string, fn: () => Promise<T>) => Promise<T>

// Seeds org_perf into whatever database/schema `prisma` points at. The caller
// guards the database. Idempotent: clears org_perf first, and every chunk
// insert skips rows already there, so `retry` may safely re-run a chunk after a
// dropped connection (tests/perf/25k passes withConnectionRetry).
export async function seedPerf(
  prisma: PrismaClient,
  opts: { retry?: Retry; log?: (line: string) => void } = {},
): Promise<{ leads: number; contacts: number; phones: number; values: number }> {
  const retry: Retry = opts.retry ?? ((_what, fn) => fn())
  const log = opts.log ?? (() => {})
  const where = { organizationId: PERF_ORG_ID }

  // Clean slate (idempotent re-seed).
  await retry('perf seed: clear org_perf', async () => {
    await prisma.customFieldValue.deleteMany({ where })
    await prisma.contactPhone.deleteMany({ where: { contact: where } })
    await prisma.contactEmail.deleteMany({ where: { contact: where } })
    await prisma.contact.deleteMany({ where })
    await prisma.customFieldDefinition.deleteMany({ where })
    await prisma.lead.deleteMany({ where })
    await prisma.user.deleteMany({ where: { id: USER_ID } })
    await prisma.organization.deleteMany({ where: { id: PERF_ORG_ID } })
  })

  await retry('perf seed: org, user, custom fields', async () => {
    await prisma.organization.upsert({
      where: { id: PERF_ORG_ID },
      create: { id: PERF_ORG_ID, slug: 'perf-org', name: 'Perf Org' },
      update: {},
    })
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: { id: USER_ID, organizationId: PERF_ORG_ID, email: 'perf-seed@example.com', displayName: 'Perf' },
      update: {},
    })
    await prisma.customFieldDefinition.createMany({ data: CUSTOM_DEFS, skipDuplicates: true })
  })

  const { leads, contacts, phones, values } = buildPerfRows()
  const chunked = async <T>(label: string, rows: T[], create: (batch: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await retry(`perf seed: ${label} ${i}..${Math.min(i + CHUNK, rows.length)}`, () => create(rows.slice(i, i + CHUNK)))
      log(`  ${label}: ${Math.min(i + CHUNK, rows.length)}/${rows.length}`)
    }
  }
  await chunked('leads', leads, (b) => prisma.lead.createMany({ data: b, skipDuplicates: true }))
  await chunked('contacts', contacts, (b) => prisma.contact.createMany({ data: b, skipDuplicates: true }))
  await chunked('phones', phones, (b) => prisma.contactPhone.createMany({ data: b, skipDuplicates: true }))
  await chunked('values', values, (b) => prisma.customFieldValue.createMany({ data: b, skipDuplicates: true }))

  const [nl, nc, np, nv] = await retry('perf seed: counts', () =>
    Promise.all([
      prisma.lead.count({ where }),
      prisma.contact.count({ where }),
      prisma.contactPhone.count({ where: { contact: where } }),
      prisma.customFieldValue.count({ where }),
    ]),
  )
  return { leads: nl, contacts: nc, phones: np, values: nv }
}

async function main() {
  const PERF_URL = process.env.DATABASE_URL_PERF
  // Brief 41.1: the shared guard first (it also refuses a database name with a
  // "/" in it; no override), then this seed's own stricter *_perf rule.
  assertTestDatabase(PERF_URL, 'seed-dev (DATABASE_URL_PERF)', { allowOverride: false })
  const PERF_DB_NAME = PERF_URL ? new URL(PERF_URL).pathname.replace(/^\//, '').split('?')[0] : '(unset)'
  if (!PERF_URL || !PERF_DB_NAME.endsWith('_perf')) {
    console.error(`REFUSING TO SEED: DATABASE_URL_PERF database name is "${PERF_DB_NAME}", must end with "_perf".`)
    process.exit(1)
  }
  const prisma = new PrismaClient({ datasources: { db: { url: PERF_URL } } })
  try {
    console.log(`Seeding perf DB: ${new URL(PERF_URL).pathname}`)
    const start = Date.now()
    const n = await seedPerf(prisma, { log: (line) => console.log(line) })
    console.log(
      `Seeded: ${n.leads} leads, ${n.contacts} contacts, ${n.phones} phones, ${n.values} custom values ` +
        `in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

// Run as CLI only when invoked directly (tests import seedPerf / buildPerfRows).
if (process.argv[1] && process.argv[1].endsWith('seed-dev.ts')) {
  main().catch((err) => {
    console.error('seed-dev failed:', err)
    process.exit(1)
  })
}
