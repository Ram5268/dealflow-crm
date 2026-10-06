import 'dotenv/config' // MUST be first — else Prisma silently defaults to localhost
import { PrismaClient } from '@prisma/client'
import { runHolidayRefresh } from '../src/lib/compliance/holidays/refresh'
import { assertTestDatabase } from '../src/lib/shared/db-guard'

// Seeds the compliance isolation fixtures (Gate 1). Idempotent — upserts by
// fixed IDs so re-running is safe. The Organization uses slug "dealflow-ryan"
// because the shell's getCurrentOrgId() resolves that singleton.
//
//   pnpm exec tsx scripts/seed-compliance-fixtures.ts
//
// Expected callable-now outcomes (server "now" within ET business hours,
// non-holiday) — or pass a controlled atInstant:
//   cp_nyc_confirmed_01   -> callable:true
//   cp_chi_01             -> policy_unconfirmed (Chicago config present, unconfirmed)
//   cp_la_01 / cp_phx_01  -> policy_unconfirmed (no config row)
//   cp_notz_01            -> timezone_unresolved
//   cp_internal_dnc_01    -> internal_dnc

// Brief 41 (H11): it writes fixtures (including a confirmed calling-window
// policy), so it refuses a live DATABASE_URL_MAIN unless run with --i-mean-live.
assertTestDatabase(process.env.DATABASE_URL_MAIN, 'seed-compliance-fixtures (DATABASE_URL_MAIN)', { allowOverride: true })

const prisma = new PrismaClient()
const ORG_ID = 'org_test'
const ORG_SLUG = 'dealflow-ryan'

interface Spec {
  leadId: string
  contactId: string
  phoneId: string
  phone: string
  tz: string | null
  addrState: string | null
}

const SPECS: Spec[] = [
  { leadId: 'lead_nyc_01', contactId: 'contact_nyc_01', phoneId: 'cp_nyc_confirmed_01', phone: '+12125550001', tz: 'America/New_York', addrState: 'NY' },
  { leadId: 'lead_nyc_02', contactId: 'contact_nyc_02', phoneId: 'cp_nyc_unconfirmed_02', phone: '+12125550002', tz: 'America/New_York', addrState: 'NY' },
  { leadId: 'lead_chi_01', contactId: 'contact_chi_01', phoneId: 'cp_chi_01', phone: '+13125550001', tz: 'America/Chicago', addrState: 'IL' },
  { leadId: 'lead_phx_01', contactId: 'contact_phx_01', phoneId: 'cp_phx_01', phone: '+16025550001', tz: 'America/Phoenix', addrState: 'AZ' },
  { leadId: 'lead_la_01', contactId: 'contact_la_01', phoneId: 'cp_la_01', phone: '+13105550001', tz: 'America/Los_Angeles', addrState: 'CA' },
  { leadId: 'lead_notz_01', contactId: 'contact_notz_01', phoneId: 'cp_notz_01', phone: '+15555550999', tz: null, addrState: null },
  { leadId: 'lead_idnc_01', contactId: 'contact_internal_dnc_01', phoneId: 'cp_internal_dnc_01', phone: '+15555550101', tz: 'America/New_York', addrState: 'NY' },
]

async function main() {
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: { slug: ORG_SLUG, name: 'DealFlow Ryan (test)' },
    create: { id: ORG_ID, slug: ORG_SLUG, name: 'DealFlow Ryan (test)' },
  })

  for (const s of SPECS) {
    const addresses = s.addrState ? [{ state: s.addrState, line1: '123 Test St' }] : []
    await prisma.lead.upsert({
      where: { id: s.leadId },
      update: { timezone: s.tz, addresses, primaryAddressFull: s.addrState ? '123 Test St' : null },
      create: {
        id: s.leadId,
        organizationId: ORG_ID,
        displayName: s.contactId,
        timezone: s.tz,
        addresses,
        primaryAddressFull: s.addrState ? '123 Test St' : null,
      },
    })
    await prisma.contact.upsert({
      where: { id: s.contactId },
      update: { timezone: s.tz },
      create: { id: s.contactId, organizationId: ORG_ID, leadId: s.leadId, displayName: s.contactId, timezone: s.tz },
    })
    await prisma.contactPhone.upsert({
      where: { id: s.phoneId },
      update: { phone: s.phone },
      create: { id: s.phoneId, contactId: s.contactId, phone: s.phone, type: 'mobile' },
    })
  }

  // NY policy CONFIRMED; Chicago policy PRESENT but UNCONFIRMED. LA/Phoenix left
  // with no row at all — all three demonstrate the policy gate fail-closing.
  await prisma.callingWindowConfig.upsert({
    where: { organizationId_timezone: { organizationId: ORG_ID, timezone: 'America/New_York' } },
    update: { policyConfirmedBy: 'user:ryan@dealflow|counsel:seed|date:2026-09-01', policyConfirmedAt: new Date() },
    create: {
      organizationId: ORG_ID,
      timezone: 'America/New_York',
      policyConfirmedBy: 'user:ryan@dealflow|counsel:seed|date:2026-09-01',
      policyConfirmedAt: new Date(),
    },
  })
  await prisma.callingWindowConfig.upsert({
    where: { organizationId_timezone: { organizationId: ORG_ID, timezone: 'America/Chicago' } },
    update: { policyConfirmedBy: null, policyConfirmedAt: null },
    create: { organizationId: ORG_ID, timezone: 'America/Chicago' }, // policyConfirmedBy stays null
  })

  // Internal DNC for cp_internal_dnc_01's phone (survives re-imports).
  await prisma.dncSuppression.upsert({
    where: { organizationId_phone_source: { organizationId: ORG_ID, phone: '+15555550101', source: 'internal' } },
    update: {},
    create: { organizationId: ORG_ID, phone: '+15555550101', source: 'internal', addedBy: 'seed', reason: 'seed_fixture' },
  })

  // Mobile-line cache warm for the primary NY phone.
  await prisma.mobileLineCache.upsert({
    where: { organizationId_phone: { organizationId: ORG_ID, phone: '+12125550001' } },
    update: { lineType: 'mobile', expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
    create: {
      organizationId: ORG_ID,
      phone: '+12125550001',
      lineType: 'mobile',
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  })

  // ImportBatch + companion Lead with source "import:ib_test_01" (bulk-scrub enumeration).
  await prisma.importBatch.upsert({
    where: { id: 'ib_test_01' },
    update: {},
    create: {
      id: 'ib_test_01',
      organizationId: ORG_ID,
      userId: 'seed',
      status: 'committed',
      sourceLabel: 'seed import',
      filename: 'seed.csv',
      storageKey: 'imports/org_test/ib_test_01/seed.csv',
    },
  })
  await prisma.lead.upsert({
    where: { id: 'lead_import_01' },
    update: { source: 'import:ib_test_01' },
    create: { id: 'lead_import_01', organizationId: ORG_ID, displayName: 'import fixture', source: 'import:ib_test_01', timezone: 'America/New_York' },
  })

  // Federal + state holidays for this year + next.
  const holidays = await runHolidayRefresh({ orgId: ORG_ID }, prisma as any)

  console.log(JSON.stringify({ seeded: { org: ORG_ID, contacts: SPECS.length, holidays } }, null, 2))
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
