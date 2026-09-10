import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'

// ─────────────────────────────────────────────────────────────────────────────
// FIX-1 PR A — backfill Lead.displayName for Mojo co-owner records.
//
// WHAT WAS ACTUALLY WRONG (differs from the original brief's diagnosis):
//   Lead.name is CORRECT — it holds Mojo's "Full Name" (the primary owner).
//   The bug was in buildRowPlan's displayName precedence: it preferred
//   Contact.name, which is mapped from Mojo's "Second Name" (the CO-OWNER).
//   Every surface that renders displayName (lead detail h2, leads list, queue,
//   dialer ammunition panel) therefore showed the co-owner instead of the owner.
//
//   This script does NOT touch Lead.name. It only realigns displayName to name.
//
// SCOPE: leads whose source is an import batch, name is non-empty, and
//        displayName differs from the whitespace-collapsed name.
//
// USAGE:
//   pnpm exec tsx scripts/one-shot/fix1-name-precedence.ts            # dry run (default)
//   pnpm exec tsx scripts/one-shot/fix1-name-precedence.ts --apply    # writes
//
// ROLLBACK:
//   pnpm exec tsx scripts/one-shot/fix1-name-precedence.ts --rollback /private/tmp/fix1-name-snapshot-<DATE>.json
//
// SAFETY:
//   • snapshots every affected row's id/name/displayName before writing
//   • refuses to overwrite an existing snapshot file (idempotency guard)
//   • sequential writes only — the original import blew Railway's 20-conn pool
//   • idempotent: a second --apply run finds 0 rows to change
// ─────────────────────────────────────────────────────────────────────────────

const collapseWs = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim()
const DATE = new Date().toISOString().slice(0, 10)
const SNAPSHOT = `/private/tmp/fix1-name-snapshot-${DATE}.json`
const CHANGELOG = `/private/tmp/fix1-name-changes-${DATE}.jsonl`

interface Row { id: string; name: string | null; displayName: string; source: string | null }

async function rollback(prisma: PrismaClient, file: string) {
  if (!fs.existsSync(file)) throw new Error(`snapshot not found: ${file}`)
  const snap: Row[] = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`rollback: restoring ${snap.length} rows from ${file}`)
  let restored = 0
  for (const r of snap) {
    await prisma.lead.update({ where: { id: r.id }, data: { displayName: r.displayName } })
    restored++
    if (restored % 100 === 0) console.log(`  ...${restored}/${snap.length}`)
  }
  console.log(`rollback complete: ${restored} rows restored`)
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const rollbackIdx = args.indexOf('--rollback')
  const prisma = new PrismaClient()

  if (rollbackIdx >= 0) {
    await rollback(prisma, args[rollbackIdx + 1])
    await prisma.$disconnect()
    return
  }

  const leads = await prisma.lead.findMany({
    where: { source: { startsWith: 'import:' } },
    select: { id: true, name: true, displayName: true, source: true },
  })

  const changes = leads
    .map((l) => ({ row: l as Row, next: collapseWs(l.name) }))
    .filter(({ row, next }) => next !== '' && next !== row.displayName)

  console.log(`mode          : ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`)
  console.log(`rows scanned  : ${leads.length}`)
  console.log(`rows to change: ${changes.length}`)
  console.log(`rows unchanged: ${leads.length - changes.length}`)

  if (changes.length === 0) {
    console.log('\nnothing to do — already converged (script is idempotent).')
    await prisma.$disconnect()
    return
  }

  // changelog is written in BOTH modes so a dry run is reviewable
  fs.writeFileSync(
    CHANGELOG,
    changes.map((c) => JSON.stringify({ leadId: c.row.id, oldName: c.row.displayName, newName: c.next })).join('\n') + '\n'
  )
  console.log(`changelog     : ${CHANGELOG}`)

  console.log('\nfirst 5 planned changes:')
  changes.slice(0, 5).forEach((c) => console.log(`  ${c.row.id}  ${JSON.stringify(c.row.displayName)} -> ${JSON.stringify(c.next)}`))

  if (!apply) {
    console.log('\ndry run complete — no rows written. Re-run with --apply to commit.')
    await prisma.$disconnect()
    return
  }

  if (fs.existsSync(SNAPSHOT)) {
    throw new Error(`snapshot already exists, refusing to overwrite: ${SNAPSHOT}\n(delete it deliberately if you intend to re-apply)`)
  }
  fs.writeFileSync(SNAPSHOT, JSON.stringify(changes.map((c) => c.row), null, 1))
  console.log(`\nsnapshot      : ${SNAPSHOT} (${changes.length} rows)`)

  let updated = 0
  for (const c of changes) {
    await prisma.lead.update({ where: { id: c.row.id }, data: { displayName: c.next } })
    updated++
    if (updated % 100 === 0) console.log(`  ...${updated}/${changes.length}`)
  }
  console.log(`\napplied: ${updated} rows updated`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
