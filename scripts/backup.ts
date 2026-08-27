import 'dotenv/config'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

// Logical backup of the A-owned tables to a timestamped JSON file (and R2 in
// prod via the importer storage layer). NOTE: production should prefer a
// physical `pg_dump` to R2 on a pg-boss weekly cron; pg_dump is not installed in
// this build environment, so this Prisma-based logical export is the portable
// fallback and is what restore-from-backup.ts consumes.

const prisma = new PrismaClient()
const OUT_DIR = path.join(process.cwd(), 'backups')

async function main() {
  const stamp = process.argv[2] ?? 'manual'
  await fs.mkdir(OUT_DIR, { recursive: true })

  const data = {
    stamp,
    organizations: await prisma.organization.findMany(),
    users: await prisma.user.findMany(),
    leads: await prisma.lead.findMany(),
    contacts: await prisma.contact.findMany(),
    contactPhones: await prisma.contactPhone.findMany(),
    contactEmails: await prisma.contactEmail.findMany(),
    customFieldDefinitions: await prisma.customFieldDefinition.findMany(),
    customFieldValues: await prisma.customFieldValue.findMany(),
    savedViews: await prisma.savedView.findMany(),
    dealFlowDerivedSignals: await prisma.dealFlowDerivedSignal.findMany(),
  }

  const file = path.join(OUT_DIR, `backup-${stamp}.json`)
  await fs.writeFile(file, JSON.stringify(data, null, 2))
  console.log(
    `backup written: ${file} (${data.leads.length} leads, ${data.contacts.length} contacts, ${data.savedViews.length} views)`
  )
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('backup failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
