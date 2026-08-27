import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({ message: { create: vi.fn(), update: vi.fn() } }))
const compliance = vi.hoisted(() => ({ isCallable: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../clients/compliance', () => compliance)

import { sendSmsMessage, ComplianceBlockedError } from './send'
import { SmsDisabledError } from './config'

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_MESSAGING_SERVICE_SID: 'MG1',
  TWILIO_10DLC_BRAND_ID: 'B',
  TWILIO_10DLC_CAMPAIGN_ID: 'C',
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  for (const k of ['SMS_ENABLED', ...Object.keys(TWILIO_ENV)]) delete process.env[k]
})

describe('sendSmsMessage — parked (SMS_ENABLED=false)', () => {
  it('throws SmsDisabledError and never touches Twilio', async () => {
    process.env.SMS_ENABLED = 'false'
    await expect(sendSmsMessage({ orgId: 'o', toPhone: '+1', body: 'x' })).rejects.toBeInstanceOf(
      SmsDisabledError,
    )
    expect(compliance.isCallable).not.toHaveBeenCalled()
    expect(db.message.create).not.toHaveBeenCalled()
  })
})

describe('sendSmsMessage — enabled', () => {
  beforeEach(() => {
    process.env.SMS_ENABLED = 'true'
    Object.assign(process.env, TWILIO_ENV)
  })

  it('blocks (fail-closed reasons echoed) when not callable — no row, no send', async () => {
    compliance.isCallable.mockResolvedValue({ phone: '+1', callable: false, reasons: ['internal_dnc'] })
    const sender = vi.fn()
    await expect(
      sendSmsMessage({ orgId: 'o', toPhone: '+1', body: 'x' }, { sender }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError)
    expect(db.message.create).not.toHaveBeenCalled()
    expect(sender).not.toHaveBeenCalled()
  })

  it('sends when callable → message row sent with twilio sid + delivery state', async () => {
    compliance.isCallable.mockResolvedValue({ phone: '+15553334444', callable: true, reasons: [] })
    db.message.create.mockResolvedValue({ id: 'm1' })
    db.message.update.mockResolvedValue({})
    const sender = vi.fn(async () => ({ sid: 'SM9', status: 'queued' }))

    const r = await sendSmsMessage({ orgId: 'o', toPhone: '+15553334444', body: 'hi' }, { sender })
    expect(r).toEqual({ messageId: 'm1', status: 'sent' })
    expect(sender).toHaveBeenCalledOnce()
    expect(db.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: expect.objectContaining({
          status: 'sent',
          providerMessageId: 'twilio:SM9',
          providerDeliveryState: 'queued',
        }),
      }),
    )
  })

  it('fails fast when enabled but 10DLC SIDs are missing', async () => {
    delete process.env.TWILIO_MESSAGING_SERVICE_SID
    await expect(sendSmsMessage({ orgId: 'o', toPhone: '+1', body: 'x' })).rejects.toThrow(
      /10DLC\/Twilio config is incomplete/,
    )
  })
})
