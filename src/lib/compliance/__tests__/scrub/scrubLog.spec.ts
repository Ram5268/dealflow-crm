import { describe, it, expect } from 'vitest'
import { writeScrubLogs } from '@/lib/compliance/scrub/scrubLog'

describe('writeScrubLogs', () => {
  it('no-ops on an empty batch', async () => {
    let called = false
    const db = { scrubLog: { createMany: async () => ((called = true), { count: 0 }) } }
    await writeScrubLogs('o', [], db)
    expect(called).toBe(false)
  })

  it('createMany with orgId stamped and null contactPhoneId default', async () => {
    let received: any
    const db = { scrubLog: { createMany: async (args: any) => ((received = args), { count: args.data.length }) } }
    await writeScrubLogs(
      'org_x',
      [
        { phone: '+1', operation: 'check-window', result: 'clean' },
        { phone: '+2', contactPhoneId: 'cp2', operation: 'check-internal', result: 'blocked', detail: { x: 1 } },
      ],
      db
    )
    expect(received.data).toHaveLength(2)
    expect(received.data[0]).toMatchObject({ organizationId: 'org_x', phone: '+1', contactPhoneId: null, result: 'clean' })
    expect(received.data[1]).toMatchObject({ contactPhoneId: 'cp2', detail: { x: 1 } })
  })
})
