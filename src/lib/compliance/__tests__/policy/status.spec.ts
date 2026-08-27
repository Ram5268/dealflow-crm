import { describe, it, expect } from 'vitest'
import { getPolicyStatus } from '@/lib/compliance/policy/status'

describe('getPolicyStatus', () => {
  const confirmedAt = new Date('2026-09-01T00:00:00Z')

  const db = {
    callingWindowConfig: {
      findMany: async () => [
        {
          timezone: 'America/New_York',
          earliestHour: 9,
          latestHour: 20,
          allowedDaysOfWeek: [1, 2, 3, 4, 5],
          policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
          policyConfirmedAt: confirmedAt,
        },
        {
          timezone: 'America/Chicago',
          earliestHour: 9,
          latestHour: 20,
          allowedDaysOfWeek: [1, 2, 3, 4, 5],
          policyConfirmedBy: null, // present but unconfirmed
          policyConfirmedAt: null,
        },
      ],
    },
    contact: {
      findMany: async () => [
        { timezone: 'America/New_York' }, // confirmed -> not listed
        { timezone: 'America/Chicago' }, // present-but-unconfirmed -> listed
        { timezone: 'America/Los_Angeles' }, // no config at all -> listed
      ],
    },
  }

  it('lists configs and computes unconfirmedTimezones (no-config OR null policyConfirmedBy)', async () => {
    const status = await getPolicyStatus('o', db as any)
    expect(status.configs).toHaveLength(2)
    expect(status.configs[0].policyConfirmedAt).toBe(confirmedAt.toISOString())
    expect(status.configs[1].policyConfirmedAt).toBeNull()

    expect(status.unconfirmedTimezones.sort()).toEqual(['America/Chicago', 'America/Los_Angeles'])
    expect(status.unconfirmedTimezones).not.toContain('America/New_York')
  })
})
