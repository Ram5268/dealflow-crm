// Brief 41 (H13) — rewrite stored phones in canonical E.164 (+19173312047).
//
// Opt-outs (DncSuppression) and contact phones added before Brief 41 could be
// stored as typed ("9173312047", "(917) 331-2047"), so an opt-out and a lead's
// phone could fail to match. The code now stores and matches canonical form
// (and still matches the old forms); this rewrites what is already stored so
// every check sees one form. Plan: src/lib/compliance/dnc/phoneBackfill.ts
// (nothing is deleted; values that aren't phone numbers are only reported).
//
// A production data step on the LIVE CRM: run it only with Ryan's OK. It never
// prints a phone number, only counts and row ids.
//
//   npx tsx scripts/brief41-canonical-phones.ts                          # dry run (default; reads only)
//   npx tsx scripts/brief41-canonical-phones.ts --apply --i-mean-live    # rewrite the rows in the live CRM
// (--apply on a non-test database needs --i-mean-live; see src/lib/shared/db-guard.ts)
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { planPhoneBackfill } from '../src/lib/compliance/dnc/phoneBackfill'
import { assertTestDatabase } from '../src/lib/shared/db-guard'

const prisma = new PrismaClient()
const BATCH = 200

async function main() {
  const apply = process.argv.includes('--apply')
  // Brief 41 (H11): writing to a non-test database is a deliberate step.
  if (apply) assertTestDatabase(process.env.DATABASE_URL_MAIN, 'brief41-canonical-phones --apply (DATABASE_URL_MAIN)', { allowOverride: true })
  const dncRows = await prisma.dncSuppression.findMany({ select: { id: true, organizationId: true, source: true, phone: true } })
  const phoneRows = await prisma.contactPhone.findMany({ select: { id: true, contactId: true, phone: true } })
  const plan = planPhoneBackfill(dncRows, phoneRows)
  console.log(JSON.stringify({
    optOutRows: dncRows.length,
    optOutsToRewrite: plan.dnc.rewrite.length,
    optOutsAlreadyCoveredByACanonicalRow: plan.dnc.alreadyCovered.length,
    optOutsNotAPhoneNumber: plan.dnc.unparseable,
    contactPhoneRows: phoneRows.length,
    contactPhonesToRewrite: plan.contactPhones.rewrite.length,
    contactPhonesAlreadyCoveredOnTheirContact: plan.contactPhones.alreadyCovered.length,
    contactPhonesNotAPhoneNumber: plan.contactPhones.unparseable,
  }, null, 2))

  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to rewrite them.')
    return
  }
  let dnc = 0
  let phones = 0
  for (let i = 0; i < plan.dnc.rewrite.length; i += BATCH) {
    const batch = plan.dnc.rewrite.slice(i, i + BATCH)
    await prisma.$transaction(batch.map((r) => prisma.dncSuppression.update({ where: { id: r.id }, data: { phone: r.phone } })))
    dnc += batch.length
  }
  for (let i = 0; i < plan.contactPhones.rewrite.length; i += BATCH) {
    const batch = plan.contactPhones.rewrite.slice(i, i + BATCH)
    await prisma.$transaction(batch.map((r) => prisma.contactPhone.update({ where: { id: r.id }, data: { phone: r.phone } })))
    phones += batch.length
  }
  console.log(`Rewrote ${dnc} opt-out row(s) and ${phones} contact phone(s) to canonical E.164.`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
