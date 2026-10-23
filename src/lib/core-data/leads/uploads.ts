import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { importIdsOf, type Uploads } from '@/lib/ui/source'

// Brief 50 PR 14 (open item 6.16): the Source label, file name and upload time
// of each import these lead sources name, so Source reads "Mojo Export" instead
// of "import:<id>" (sourceLabel, src/lib/ui/source.ts). One query, scoped to the
// organization; none when no source names an import.
export async function loadUploads(
  organizationId: string,
  sources: Iterable<string | null | undefined>,
  db: PrismaClient = prisma,
): Promise<Uploads> {
  const ids = importIdsOf(sources)
  if (ids.length === 0) return {}
  const batches = await db.importBatch.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, sourceLabel: true, filename: true, createdAt: true },
  })
  return Object.fromEntries(
    batches.map((b) => [b.id, { label: b.sourceLabel, filename: b.filename, createdAt: b.createdAt.toISOString() }]),
  )
}
