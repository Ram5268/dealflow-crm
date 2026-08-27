import { describe, it, expect } from 'vitest'
import { smsEnabled, requireTwilioConfig, SmsDisabledError } from './config'

const full = {
  SMS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_MESSAGING_SERVICE_SID: 'MG1',
  TWILIO_10DLC_BRAND_ID: 'BN1',
  TWILIO_10DLC_CAMPAIGN_ID: 'CM1',
}

describe('smsEnabled', () => {
  it('true only when SMS_ENABLED === "true"', () => {
    expect(smsEnabled({ SMS_ENABLED: 'true' })).toBe(true)
    expect(smsEnabled({ SMS_ENABLED: 'false' })).toBe(false)
    expect(smsEnabled({})).toBe(false)
  })
})

describe('requireTwilioConfig', () => {
  it('returns config when everything is present', () => {
    const cfg = requireTwilioConfig(full)
    expect(cfg.messagingServiceSid).toBe('MG1')
    expect(cfg.apiBase).toBe('https://api.twilio.com')
  })

  it('fails fast listing every missing 10DLC var', () => {
    expect(() => requireTwilioConfig({ SMS_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC1' })).toThrow(
      /TWILIO_MESSAGING_SERVICE_SID.*TWILIO_10DLC_BRAND_ID.*TWILIO_10DLC_CAMPAIGN_ID/,
    )
  })

  it('honors a custom API base (for the Twilio mock)', () => {
    expect(requireTwilioConfig({ ...full, TWILIO_API_BASE: 'http://localhost:4002' }).apiBase).toBe(
      'http://localhost:4002',
    )
  })
})

describe('SmsDisabledError', () => {
  it('carries the sms_pending_10dlc code', () => {
    expect(new SmsDisabledError().code).toBe('sms_pending_10dlc')
  })
})
