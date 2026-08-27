import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { confirmPolicy, PolicyValidationError } from '@/lib/compliance/policy/confirm'
import { getPolicyStatus } from '@/lib/compliance/policy/status'

// Gate 2 — policy confirm + status wire shapes.
const statusSchema = z
  .object({
    configs: z.array(
      z.object({
        timezone: z.string(),
        earliestHour: z.number(),
        latestHour: z.number(),
        allowedDaysOfWeek: z.array(z.number()),
        policyConfirmedBy: z.string().nullable(),
        policyConfirmedAt: z.string().nullable(),
      })
    ),
    unconfirmedTimezones: z.array(z.string()),
  })
  .strict()

const VALID = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
}

describe('policy contracts', () => {
  it('confirm returns a row carrying the confirmed policy fields', async () => {
    const now = new Date('2026-09-01T00:00:00Z')
    const db = {
      callingWindowConfig: {
        upsert: async (a: any) => ({
          timezone: a.where.organizationId_timezone.timezone,
          earliestHour: a.create.earliestHour,
          latestHour: a.create.latestHour,
          allowedDaysOfWeek: a.create.allowedDaysOfWeek,
          policyConfirmedBy: a.create.policyConfirmedBy,
          policyConfirmedAt: a.create.policyConfirmedAt,
        }),
      },
    }
    const row = await confirmPolicy('o', VALID, { db: db as any, now })
    expect(row.policyConfirmedBy).toBe(VALID.policyConfirmedBy)
    expect(row.policyConfirmedAt).toBe(now)
  })

  it('confirm rejects invalid input with a PolicyValidationError (=> HTTP 400)', async () => {
    const db = { callingWindowConfig: { upsert: async () => ({}) } }
    await expect(confirmPolicy('o', { ...VALID, latestHour: 8 }, { db: db as any })).rejects.toThrow(
      PolicyValidationError
    )
  })

  it('status conforms to the locked shape', async () => {
    const db = {
      callingWindowConfig: {
        findMany: async () => [
          { ...VALID, policyConfirmedAt: new Date('2026-09-01T00:00:00Z') },
        ],
      },
      contact: { findMany: async () => [{ timezone: 'America/New_York' }, { timezone: 'America/Chicago' }] },
    }
    const status = await getPolicyStatus('o', db as any)
    expect(() => statusSchema.parse(status)).not.toThrow()
    expect(status.unconfirmedTimezones).toEqual(['America/Chicago'])
  })
})
