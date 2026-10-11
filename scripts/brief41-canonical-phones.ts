// Brief 41 (H13) — rewrite stored phones in canonical E.164 (+19173312047).
//
// Opt-outs (DncSuppression) and contact phones added before Brief 41 could be
// stored as typed ("9173312047", "(917) 331-2047"), so an opt-out and a lead's
// phone could fail to match. The code now stores and matches canonical form
// (and still matches the old forms); this rewrites what is already stored so
// every check sees one form. Plan: src/lib/compliance/dnc/phoneBackfill.ts
// (nothing is deleted; values that aren't phone numbers are only reported).
//
// Brief 41.1: how it runs is src/lib/compliance/dnc/phoneBackfillRun.ts.
// --apply needs --expect <n> (the count from the dry run Ryan approved), saves
// a private before-image first (outside the repo; it holds phone numbers), and
// writes each row only if it still holds the phone the dry run saw (a row
// changed meanwhile is skipped and reported). --restore <file> undoes it.
//
// A production data step on the LIVE CRM: run it only with Ryan's OK, while no
// import, sync or opt-out refresh is running. It never prints a phone number,
// only counts and row ids.
//
//   npx tsx scripts/brief41-canonical-phones.ts                                      # dry run (default; reads only)
//   npx tsx scripts/brief41-canonical-phones.ts --apply --expect <n> --i-mean-live   # rewrite the rows in the live CRM
//   npx tsx scripts/brief41-canonical-phones.ts --restore <before-image.json>        # what an undo would do
//   npx tsx scripts/brief41-canonical-phones.ts --restore <file> --apply --expect <n> --i-mean-live
// --preimage-dir <dir> picks where the before-image goes (default ~/dev/brief41-1/private).
// (--apply on a non-test database needs --i-mean-live; see src/lib/shared/db-guard.ts)
import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { runPhoneBackfill, type BackfillDb } from '../src/lib/compliance/dnc/phoneBackfillRun'
import { assertTestDatabase, databaseName, scriptArgs } from '../src/lib/shared/db-guard'

const prisma = new PrismaClient()

async function main() {
  const args = scriptArgs()
  // Brief 41 (H11): writing to a non-test database is a deliberate step.
  if (args.includes('--apply')) assertTestDatabase(process.env.DATABASE_URL_MAIN, 'brief41-canonical-phones --apply (DATABASE_URL_MAIN)', { allowOverride: true })
  await runPhoneBackfill({
    db: prisma as unknown as BackfillDb,
    args,
    log: (line) => console.log(line),
    database: databaseName(process.env.DATABASE_URL_MAIN),
    repoRoot: path.resolve(__dirname, '..'),
    defaultPreImageDir: path.join(os.homedir(), 'dev', 'brief41-1', 'private'),
  })
}

main()
  .catch((e) => {
    console.error(e instanceof Error && e.message.startsWith('REFUSING') ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
