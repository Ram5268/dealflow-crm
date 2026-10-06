import { describe, it, expect } from 'vitest'
import { buildRowPlan, groupRowsByIdentity, resolveMapping } from '@/lib/core-data/importer/commit-worker'
import type { ColumnMapping } from '@/lib/core-data/importer/ai-mapping'

// Brief 41 (M25a): rows that could be the same lead import one after another.
const col = (column: string, field: string): ColumnMapping =>
  ({ column, sampleValues: [], target: { kind: 'standard_field', field }, confidence: 1, reasoning: '' }) as ColumnMapping
const resolved = resolveMapping(
  [col('Mojo', 'Lead.mojoId'), col('Name', 'Lead.name'), col('Addr', 'Lead.primaryAddressFull'), col('Phone', 'ContactPhone.phone'), col('Phone2', 'ContactPhone.phone')],
  [],
)
const plan = (r: Record<string, string>) => buildRowPlan({ Mojo: '', Name: '', Addr: '', Phone: '', Phone2: '', ...r }, resolved)

describe('groupRowsByIdentity', () => {
  it('joins rows that share a Mojo ID, any phone, or a name + street; keeps file order', () => {
    const plans = [
      plan({ Mojo: 'M1', Phone: '2125550101' }), // 0
      plan({ Name: 'Ann', Phone: '2125550199' }), // 1 (alone)
      plan({ Phone: '2125550102', Phone2: '2125550101' }), // 2 → 0 via second phone
      plan({ Mojo: 'M1' }), // 3 → 0 via Mojo
      plan({ Name: 'Jane Doe', Addr: '1 Main St', Phone: '2125550150' }), // 4
      plan({ Name: 'Jane Doe', Addr: '1 Main Street, Brooklyn' }), // 5 → 4 via name + street
      plan({ Name: 'Bob', Addr: '9 Oak Ave' }), // 6 (alone)
    ]
    expect(groupRowsByIdentity(plans)).toEqual([[0, 2, 3], [1], [4, 5], [6]])
  })

  it('rows with no name or address are not joined by the "Imported Lead" fallback name', () => {
    const plans = [plan({ Phone: '2125550111' }), plan({ Phone: '2125550112' }), plan({ Phone: '2125550113' })]
    expect(groupRowsByIdentity(plans)).toEqual([[0], [1], [2]])
  })
})
