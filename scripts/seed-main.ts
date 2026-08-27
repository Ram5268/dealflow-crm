import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

// Seeds the singleton org + user into DATABASE_URL_MAIN. Single-seat MVP:
// slug 'dealflow-ryan' is what getCurrentOrgId() resolves. Idempotent (upsert).

const prisma = new PrismaClient()

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'dealflow-ryan' },
    update: {},
    create: { slug: 'dealflow-ryan', name: 'Ryan Martin — Douglas Elliman' },
  })
  await prisma.user.upsert({
    where: { email: 'ryanmar5268@gmail.com' },
    update: { organizationId: org.id },
    create: {
      organizationId: org.id,
      email: 'ryanmar5268@gmail.com',
      displayName: 'Ryan Martin',
    },
  })
  console.log(`seed-main: org ${org.id} (dealflow-ryan) + user ready`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('seed-main failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
