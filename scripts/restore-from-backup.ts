import 'dotenv/config'
import { promises as fs } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { assertTestDatabase, scriptArgs } from '../src/lib/shared/db-guard'

// Restores a logical backup produced by scripts/backup.ts. Idempotent: upserts
// by primary key so a restore can be re-run. Usage:
//   pnpm tsx scripts/restore-from-backup.ts backups/backup-<stamp>.json
//   (add --i-mean-live, anywhere, to restore into a non-test database)
// REQUIRED for Gate 1 sign-off (tested once). Production physical restores use
// `pg_restore` from the pg_dump artifact.

// Brief 41 (H11): a restore overwrites rows, so it refuses a live
// DATABASE_URL_MAIN unless run with --i-mean-live (a deliberate live restore).
assertTestDatabase(process.env.DATABASE_URL_MAIN, 'restore-from-backup (DATABASE_URL_MAIN)', { allowOverride: true })

const prisma = new PrismaClient()

// Rows come from arbitrary backup JSON, so they are untyped here; each caller
// hands them to the matching Prisma delegate. `any` is deliberate for a restore.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsertAll(
  rows: any[],
  upsert: (row: any) => Promise<unknown>
): Promise<number> {
  for (const r of rows) await upsert(r)
  return rows.length
}

async function main() {
  const file = scriptArgs()[0]
  if (!file) throw new Error('usage: restore-from-backup.ts <backup.json>')
  const data = JSON.parse(await fs.readFile(file, 'utf8'))

  // Order matters for FKs: org/user → lead → contact → phones/emails; defs → values.
  await upsertAll(data.organizations, (o) =>
    prisma.organization.upsert({ where: { id: o.id }, create: o, update: o })
  )
  await upsertAll(data.users, (u) => prisma.user.upsert({ where: { id: u.id }, create: u, update: u }))
  const nl = await upsertAll(data.leads, (l) => prisma.lead.upsert({ where: { id: l.id }, create: l, update: l }))
  await upsertAll(data.contacts, (c) => prisma.contact.upsert({ where: { id: c.id }, create: c, update: c }))
  await upsertAll(data.contactPhones, (p) =>
    prisma.contactPhone.upsert({ where: { id: p.id }, create: p, update: p })
  )
  await upsertAll(data.contactEmails, (e) =>
    prisma.contactEmail.upsert({ where: { id: e.id }, create: e, update: e })
  )
  await upsertAll(data.customFieldDefinitions, (d) =>
    prisma.customFieldDefinition.upsert({ where: { id: d.id }, create: d, update: d })
  )
  await upsertAll(data.customFieldValues, (v) =>
    prisma.customFieldValue.upsert({ where: { id: v.id }, create: v, update: v })
  )
  await upsertAll(data.savedViews, (s) =>
    prisma.savedView.upsert({ where: { id: s.id }, create: s, update: s })
  )
  await upsertAll(data.dealFlowDerivedSignals, (s) =>
    prisma.dealFlowDerivedSignal.upsert({ where: { id: s.id }, create: s, update: s })
  )

  console.log(`restore complete from ${file} (${nl} leads restored)`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('restore failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
