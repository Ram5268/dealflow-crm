// Brief 41.1 (F5) — add the opt-out for any saved STOP text that has none.
//
// The SMS webhook saves an inbound text first and then records its opt-out; if
// that write fails it answers 500, and Twilio doesn't redeliver unless the
// webhook URL's retry settings ask it to (docs/10dlc-status.md). This finds
// saved inbound texts that read as opt-outs (src/lib/comms/sms/opt-out.ts:
// STOP-type keywords, or a longer message containing one) whose number has no
// internal opt-out row, and adds one per number. Plan and apply:
// src/lib/comms/sms/stop-sweep.ts. While SMS is off it finds nothing.
//
// A production data step on the LIVE CRM: run --apply only with Ryan's OK. It
// never prints a phone number or a message body, only counts and message ids.
//
//   npx tsx scripts/brief41-1-stop-sweep.ts                          # dry run (default; reads only)
//   npx tsx scripts/brief41-1-stop-sweep.ts --apply --i-mean-live    # add the missing opt-outs in the live CRM
// (--apply on a non-test database needs --i-mean-live; see src/lib/shared/db-guard.ts)
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { applyStopSweep, describeStopSweep, planStopSweep, type StopSweepDb } from '../src/lib/comms/sms/stop-sweep'
import { assertTestDatabase } from '../src/lib/shared/db-guard'

const prisma = new PrismaClient()

async function main() {
  const apply = process.argv.includes('--apply')
  // Writing to a non-test database is a deliberate step.
  if (apply) assertTestDatabase(process.env.DATABASE_URL_MAIN, 'brief41-1-stop-sweep --apply (DATABASE_URL_MAIN)', { allowOverride: true })
  const db = prisma as unknown as StopSweepDb
  const plan = await planStopSweep(db)
  console.log(JSON.stringify(describeStopSweep(plan), null, 2))
  if (!apply) {
    console.log(plan.missing.length ? 'Dry run: nothing changed. Re-run with --apply to add them.' : 'Dry run: nothing to add.')
    return
  }
  const { added, alreadyThere } = await applyStopSweep(db, plan)
  console.log(`Added ${added} opt-out(s); ${alreadyThere} were already on the list.`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
