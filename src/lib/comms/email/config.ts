/**
 * Brief 37 — the test-phase email switch. It carries out Ryan's instruction
 * that nothing contacts a CRM lead during the test phase (no email, texts or
 * calls; standing since Brief 37, 2026-09-27). The switch itself is an engineering precaution: it mirrors
 * SMS_ENABLED, so email sends only when EMAIL_ENABLED is exactly 'true'; unset
 * (the default) means OFF, so nothing changes in Vercel to keep it off. The
 * check lives inside sendEmailMessage, so the inbox send and the send-email
 * worker both hit it; the sequence tick also stands still while it is off.
 */

export function emailEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EMAIL_ENABLED === 'true'
}

export class EmailDisabledError extends Error {
  readonly code = 'email_disabled'
  constructor() {
    super('Email is off (EMAIL_ENABLED is not true). Nothing was sent.')
    this.name = 'EmailDisabledError'
  }
}
