import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { toBuyers, type DealflowBuyer } from './buyers'

// Brief 38 — reads the buyers stored on a lead's DealFlow signal. A signal
// belongs to the lead DealFlow names (crmLeadId), else to the lead with its
// mojoId: the order the sync maps them in (write.ts MAPPED_LEADS).

export async function getLeadBuyers(
  organizationId: string,
  lead: { id: string; mojoId: string | null },
  db: PrismaClient = prisma
): Promise<DealflowBuyer[]> {
  const rows = await db.$queryRaw<{ buyers: unknown }[]>`
    SELECT s."dealflowRawJson"->'buyers' AS buyers FROM "DealFlowDerivedSignal" s
    WHERE s."organizationId" = ${organizationId}
      AND (s."dealflowRawJson"->>'crmLeadId' = ${lead.id}
        OR (s."mojoId" = ${lead.mojoId} AND NOT EXISTS (SELECT 1 FROM "Lead" o
          WHERE o.id = s."dealflowRawJson"->>'crmLeadId' AND o."organizationId" = ${organizationId})))
    ORDER BY s."queueRank" NULLS LAST
    LIMIT 1`
  return toBuyers(rows[0]?.buyers)
}

// Each signal's best buyer, for the queue's "Best buyer" column. One read of the
// org's signals (~1,500), matched to leads in memory.
export async function bestBuyerLookup(
  organizationId: string,
  db: PrismaClient = prisma
): Promise<(lead: { leadId: string; mojoId: string | null }) => DealflowBuyer | null> {
  const rows = await db.$queryRaw<{ crmLeadId: string | null; mojoId: string; best: unknown }[]>`
    SELECT "dealflowRawJson"->>'crmLeadId' AS "crmLeadId", "mojoId", "dealflowRawJson"->'buyers'->0 AS best
    FROM "DealFlowDerivedSignal" WHERE "organizationId" = ${organizationId}`
  const byLead = new Map<string, DealflowBuyer>()
  const byMojo = new Map<string, DealflowBuyer>()
  for (const r of rows) {
    const [best] = toBuyers([r.best])
    if (!best) continue
    if (r.crmLeadId) byLead.set(r.crmLeadId, best)
    byMojo.set(r.mojoId, best)
  }
  return (lead) => byLead.get(lead.leadId) ?? (lead.mojoId ? byMojo.get(lead.mojoId) : undefined) ?? null
}
