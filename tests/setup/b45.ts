// Brief 45 — fixtures for the folders / lists / groups / Pipeline DB tests.
// Every test file makes its own throwaway organization (made-up leads only:
// "Test Owner N", "100 Example St", phones 555-0100..0199) and drops it, with
// everything in it, afterwards.
import type { PrismaClient } from "@prisma/client";

export async function makeOrg(db: PrismaClient, slug: string): Promise<string> {
  return (await db.organization.create({ data: { slug, name: `Brief 45 test ${slug}` } })).id;
}

// FK-safe teardown of everything a Brief 45 test can create in an org.
export async function dropOrg(db: PrismaClient, organizationId: string): Promise<void> {
  const where = { organizationId };
  await db.activity.deleteMany({ where });
  await db.importBatch.deleteMany({ where });
  await db.callList.deleteMany({ where }); // cascades ListMembership
  await db.folder.deleteMany({ where });
  await db.leadGroup.deleteMany({ where }); // cascades LeadGroupMembership
  await db.savedView.deleteMany({ where });
  await db.task.deleteMany({ where });
  await db.call.deleteMany({ where });
  await db.dealFlowDerivedSignal.deleteMany({ where });
  await db.callingWindowConfig.deleteMany({ where });
  await db.lead.deleteMany({ where }); // cascades contacts, phones, custom values
  await db.customFieldDefinition.deleteMany({ where });
  await db.organization.delete({ where: { id: organizationId } });
}

export interface LeadSpec {
  id?: string;
  displayName?: string;
  address?: string | null;
  priorityScore?: number | null;
  topMatchFit?: number | null;
  createdAt?: Date;
  mojoId?: string | null;
  matchReason?: string | null;
  dealflowSignalSyncedAt?: Date | null;
  timezone?: string | null;
}

export async function makeLead(db: PrismaClient, organizationId: string, spec: LeadSpec = {}): Promise<string> {
  const lead = await db.lead.create({
    data: {
      ...(spec.id ? { id: spec.id } : {}),
      organizationId,
      displayName: spec.displayName ?? "Test Owner",
      primaryAddressSummary: spec.address ?? null,
      priorityScore: spec.priorityScore ?? null,
      topMatchFit: spec.topMatchFit ?? null,
      mojoId: spec.mojoId ?? null,
      matchReason: spec.matchReason ?? null,
      dealflowSignalSyncedAt: spec.dealflowSignalSyncedAt ?? null,
      timezone: spec.timezone ?? null,
      ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
    },
  });
  return lead.id;
}

// A Mojo custom field value, read by definition name (CONTRACT §4). The
// definition is created on first use with the given type.
export async function setField(
  db: PrismaClient,
  organizationId: string,
  leadId: string,
  name: string,
  value: { valueText?: string | null; valueNumber?: number | null; valueDate?: Date | null },
  type = "text",
): Promise<void> {
  const def =
    (await db.customFieldDefinition.findFirst({ where: { organizationId, objectType: "lead", name } })) ??
    (await db.customFieldDefinition.create({
      data: { organizationId, objectType: "lead", name, type, displayOrder: 0 },
    }));
  await db.customFieldValue.upsert({
    where: { definitionId_objectId: { definitionId: def.id, objectId: leadId } },
    create: { organizationId, definitionId: def.id, objectType: "lead", objectId: leadId, ...value },
    update: value,
  });
}

export const daysBefore = (from: Date, days: number) => new Date(from.getTime() - days * 86_400_000);
