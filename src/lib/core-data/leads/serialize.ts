import { prisma } from '@/lib/prisma'

// Hydrates the populated custom fields for a lead. Per brief §7 the detail
// response includes ONLY custom fields that have a value — null-valued fields
// are hidden. Value is unwrapped from whichever value_* column the definition
// type points at.
export interface HydratedCustomField {
  definitionId: string
  name: string
  type: string
  displayOrder: number
  value: string | number | Date | unknown
}

function unwrapValue(
  type: string,
  row: { valueText: string | null; valueNumber: number | null; valueDate: Date | null; valueJson: unknown }
): unknown {
  switch (type) {
    case 'number':
      return row.valueNumber
    case 'date':
    case 'datetime':
      return row.valueDate
    case 'choices':
      return row.valueJson ?? row.valueText
    default:
      return row.valueText
  }
}

export async function hydrateCustomFields(
  leadId: string
): Promise<HydratedCustomField[]> {
  const values = await prisma.customFieldValue.findMany({
    where: { objectType: 'lead', objectId: leadId },
    include: { definition: true },
  })
  return values
    .map((v) => ({
      definitionId: v.definitionId,
      name: v.definition.name,
      type: v.definition.type,
      displayOrder: v.definition.displayOrder,
      value: unwrapValue(v.definition.type, v),
    }))
    // Hide null-valued custom fields.
    .filter((f) => f.value !== null && f.value !== undefined)
    .sort((a, b) => a.displayOrder - b.displayOrder)
}
