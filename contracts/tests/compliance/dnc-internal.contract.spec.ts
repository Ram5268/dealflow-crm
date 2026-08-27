import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { addInternalDnc } from '@/lib/compliance/dnc/internal'

// Gate 2 — internal DNC add. Locked response includes `added: boolean` (Agent D
// uses it to distinguish a new opt-out from a re-observation on SMS STOP).
const schema = z
  .object({
    id: z.string(),
    phone: z.string(),
    source: z.literal('internal'),
    addedAt: z.string(),
    added: z.boolean(),
  })
  .strict()

function storeDb() {
  const store = new Map<string, { id: string; phone: string; addedAt: Date }>()
  return {
    dncSuppression: {
      findUnique: async ({ where }: any) => store.get(where.organizationId_phone_source.phone) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `id_${store.size}`, phone: data.phone, addedAt: new Date('2026-09-01T00:00:00Z') }
        store.set(data.phone, row)
        return row
      },
    },
  }
}

describe('dnc/internal response contract', () => {
  it('returns the locked shape with added:true then added:false (idempotent)', async () => {
    const db = storeDb()
    const first = await addInternalDnc('o', { phone: '+15555550101', reason: 'sms_stop' }, db as any)
    expect(() => schema.parse(first)).not.toThrow()
    expect(first).toMatchObject({ source: 'internal', added: true })
    expect(typeof first.addedAt).toBe('string')

    const second = await addInternalDnc('o', { phone: '+15555550101' }, db as any)
    expect(() => schema.parse(second)).not.toThrow()
    expect(second.added).toBe(false)
    expect(second.id).toBe(first.id)
  })
})
