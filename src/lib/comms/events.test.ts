import { describe, it, expect, vi } from 'vitest'
import { notifyMessageReceived, CRM_MESSAGE_CHANNEL, type RawExecutor } from './events'

function fakeClient() {
  const calls: unknown[][] = []
  const client: RawExecutor = {
    $executeRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push([strings, ...values])
      return 1
    }) as RawExecutor['$executeRaw'],
  }
  return { client, calls }
}

describe('notifyMessageReceived', () => {
  it('emits pg_notify on crm_message with a schema-valid, discriminant-free payload', async () => {
    const { client, calls } = fakeClient()
    await notifyMessageReceived(
      {
        messageId: 'msg_1',
        channel: 'email',
        contactId: 'c1',
        leadId: 'l1',
        correlationId: 'corr_1',
      },
      client,
    )
    expect(calls).toHaveLength(1)
    const [, channelArg, jsonArg] = calls[0] as [unknown, string, string]
    expect(channelArg).toBe(CRM_MESSAGE_CHANNEL)
    const payload = JSON.parse(jsonArg)
    expect(payload).toEqual({
      messageId: 'msg_1',
      channel: 'email',
      contactId: 'c1',
      leadId: 'l1',
      correlationId: 'corr_1',
    })
    // No discriminant leaked in.
    expect(payload).not.toHaveProperty('eventName')
    expect(payload).not.toHaveProperty('type')
  })

  it('omits optional contactId/leadId when absent', async () => {
    const { client, calls } = fakeClient()
    await notifyMessageReceived(
      { messageId: 'm', channel: 'sms', correlationId: 'x' },
      client,
    )
    const payload = JSON.parse((calls[0] as unknown[])[2] as string)
    expect(payload).toEqual({ messageId: 'm', channel: 'sms', correlationId: 'x' })
  })

  it('rejects a malformed payload before emitting', async () => {
    const { client, calls } = fakeClient()
    await expect(
      // @ts-expect-error — missing required messageId
      notifyMessageReceived({ channel: 'email', correlationId: 'x' }, client),
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('rejects an out-of-vocabulary channel', async () => {
    const { client } = fakeClient()
    await expect(
      // @ts-expect-error — channel must be email|sms
      notifyMessageReceived({ messageId: 'm', channel: 'fax', correlationId: 'x' }, client),
    ).rejects.toThrow()
  })
})
