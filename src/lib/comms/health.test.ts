import { describe, it, expect } from 'vitest'
import { healthReport } from './health'

const base = {
  DATABASE_URL_MAIN: 'postgres://x',
  OAUTH_TOKEN_ENCRYPTION_KEY: 'key',
}

describe('healthReport', () => {
  it('ok when DB + encryption key are present', () => {
    const r = healthReport(base)
    expect(r.status).toBe('ok')
    expect(r.checks.databaseConfigured).toBe(true)
    expect(r.checks.encryptionKeyPresent).toBe(true)
  })

  it('degraded when the encryption key is missing', () => {
    expect(healthReport({ DATABASE_URL_MAIN: 'x' }).status).toBe('degraded')
  })

  it('degraded when the database is missing', () => {
    expect(healthReport({ OAUTH_TOKEN_ENCRYPTION_KEY: 'k' }).status).toBe('degraded')
  })

  it('reports optional service configuration + sms flag', () => {
    const r = healthReport({
      ...base,
      GOOGLE_CLIENT_ID: 'g',
      TWILIO_MESSAGING_SERVICE_SID: 't',
      SMS_ENABLED: 'true',
    })
    expect(r.checks.gmailConfigured).toBe(true)
    expect(r.checks.graphConfigured).toBe(false)
    expect(r.checks.twilioConfigured).toBe(true)
    expect(r.checks.smsEnabled).toBe(true)
  })
})
