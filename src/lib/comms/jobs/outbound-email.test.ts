import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.hoisted(() => ({ sendEmailMessage: vi.fn() }))
vi.mock('../email/send', () => send)

import { handleSendEmailJob } from './outbound-email'
import { EmailDisabledError } from '../email/config'
import { GraphDisabledError } from '../graph-switch'

beforeEach(() => vi.clearAllMocks())

describe('handleSendEmailJob', () => {
  it('sends the referenced message (single-job shape)', async () => {
    send.sendEmailMessage.mockResolvedValue({ status: 'sent', providerMessageId: 'gmail:<x>' })
    await handleSendEmailJob({ data: { messageId: 'm1' } })
    expect(send.sendEmailMessage).toHaveBeenCalledWith('m1')
  })

  it('handles a batched array of jobs', async () => {
    send.sendEmailMessage.mockResolvedValue({ status: 'sent', providerMessageId: 'x' })
    await handleSendEmailJob([{ data: { messageId: 'a' } }, { data: { messageId: 'b' } }])
    expect(send.sendEmailMessage).toHaveBeenCalledTimes(2)
  })

  it('rethrows so pg-boss retries on failure', async () => {
    send.sendEmailMessage.mockRejectedValue(new Error('gmail 500'))
    await expect(handleSendEmailJob({ data: { messageId: 'm1' } })).rejects.toThrow('gmail 500')
  })
})

describe('Brief 37: email off', () => {
  it('drops the job instead of retrying, so nothing goes out later', async () => {
    send.sendEmailMessage.mockRejectedValue(new EmailDisabledError())
    await expect(handleSendEmailJob([{ data: { messageId: 'a' } }, { data: { messageId: 'b' } }])).resolves.toBeUndefined()
    expect(send.sendEmailMessage).toHaveBeenCalledTimes(2)
  })
})

describe('Brief 41.2: Outlook paused', () => {
  it('drops a send that would go out through Outlook, so it cannot go out once the pause lifts', async () => {
    send.sendEmailMessage.mockRejectedValue(new GraphDisabledError())
    await expect(handleSendEmailJob([{ data: { messageId: 'a' } }, { data: { messageId: 'b' } }])).resolves.toBeUndefined()
    expect(send.sendEmailMessage).toHaveBeenCalledTimes(2)
  })
})
