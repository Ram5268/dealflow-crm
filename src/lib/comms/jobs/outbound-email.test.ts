import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.hoisted(() => ({ sendEmailMessage: vi.fn() }))
vi.mock('../email/send', () => send)

import { handleSendEmailJob } from './outbound-email'

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
