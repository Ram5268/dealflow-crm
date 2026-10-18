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

  it('Brief 37: reports all three test-phase switches, off unless exactly "true"', () => {
    expect(healthReport(base).checks).toMatchObject({ smsEnabled: false, dialingEnabled: false, emailEnabled: false })
    const on = healthReport({ ...base, SMS_ENABLED: 'true', DIALING_ENABLED: 'true', EMAIL_ENABLED: 'true' })
    expect(on.checks).toMatchObject({ smsEnabled: true, dialingEnabled: true, emailEnabled: true })
    expect(healthReport({ ...base, DIALING_ENABLED: '1', EMAIL_ENABLED: 'TRUE' }).checks).toMatchObject({ dialingEnabled: false, emailEnabled: false })
  })

  it('Brief 41.2: reports the Outlook switch the same way, off unless exactly "true"', () => {
    for (const value of [undefined, '', 'TRUE', '1']) {
      expect(healthReport({ ...base, GRAPH_ENABLED: value }).checks.graphEnabled).toBe(false)
    }
    expect(healthReport({ ...base, GRAPH_ENABLED: 'true' }).checks.graphEnabled).toBe(true)
    // A switch, not a hard requirement: Outlook off never degrades the report.
    expect(healthReport(base).status).toBe('ok')
  })
})
