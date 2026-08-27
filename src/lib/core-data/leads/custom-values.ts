import type { Prisma } from '@prisma/client'

// Maps a raw incoming value to the correct value_* column payload for a custom
// field of a given type. Shared by the custom-values endpoint and the importer.
export function buildCustomValueColumns(
  type: string,
  raw: unknown
): Pick<Prisma.CustomFieldValueCreateInput, 'valueText' | 'valueNumber' | 'valueDate' | 'valueJson'> {
  const base = { valueText: null, valueNumber: null, valueDate: null, valueJson: undefined } as Pick<
    Prisma.CustomFieldValueCreateInput,
    'valueText' | 'valueNumber' | 'valueDate' | 'valueJson'
  >
  if (raw === null || raw === undefined || raw === '') return base
  switch (type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,]/g, ''))
      return { ...base, valueNumber: Number.isFinite(n) ? n : null }
    }
    case 'date':
    case 'datetime': {
      const d = raw instanceof Date ? raw : new Date(String(raw))
      return { ...base, valueDate: isNaN(d.getTime()) ? null : d }
    }
    case 'choices': {
      return { ...base, valueJson: raw as Prisma.InputJsonValue, valueText: Array.isArray(raw) ? raw.join(', ') : String(raw) }
    }
    default:
      return { ...base, valueText: String(raw) }
  }
}
