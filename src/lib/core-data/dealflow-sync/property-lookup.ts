import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { toPropertyFacts, type DealflowProperty } from './property'

// Brief 44 (PR 5): reads DealFlow's estimate stored on a lead's signal
// (dealflowRawJson.property). The signal is found the way getLeadBuyers finds
// it (buyer-lookup.ts): the lead DealFlow names (crmLeadId), else the lead with
// its mojoId. Whitelisted again on the way out, so the card only ever sees
// toPropertyFacts' fields. Null before any published run, or when DealFlow's
// latest call list doesn't include this seller.
export async function getLeadProperty(
  organizationId: string,
  lead: { id: string; mojoId: string | null },
  db: PrismaClient = prisma
): Promise<DealflowProperty | null> {
  const rows = await db.$queryRaw<{ property: unknown }[]>`
    SELECT s."dealflowRawJson"->'property' AS property FROM "DealFlowDerivedSignal" s
    WHERE s."organizationId" = ${organizationId}
      AND (s."dealflowRawJson"->>'crmLeadId' = ${lead.id}
        OR (s."mojoId" = ${lead.mojoId} AND NOT EXISTS (SELECT 1 FROM "Lead" o
          WHERE o.id = s."dealflowRawJson"->>'crmLeadId' AND o."organizationId" = ${organizationId})))
    ORDER BY s."queueRank" NULLS LAST
    LIMIT 1`
  return toPropertyFacts(rows[0]?.property)
}
