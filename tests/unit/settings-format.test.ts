import { describe, it, expect } from 'vitest'
import {
  SETTINGS_SECTIONS,
  DEFAULT_SETTINGS_SLUG,
  isActiveSettingsPath,
  findSettingsSection,
  settingsHref,
} from '@/lib/settings/nav'
import {
  formatAllowedDays,
  formatHour,
  formatMinutes,
  formatWindow,
  isMailboxConnected,
  mailboxCardActions,
  maskCallerId,
  pacingBandRows,
  spendPercent,
  spendTone,
} from '@/lib/settings/format'
import { ABANDONMENT_BANDS } from '@/lib/telephony/pacing/computeNewLineCount'
import { evaluateCallingWindow } from '@/lib/compliance/timezone/windowCheck'

describe('settings nav', () => {
  it('exposes the five sections the brief names plus Do not contact, profile first', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.slug)).toEqual([
      'profile',
      'connected-accounts',
      'calling',
      'compliance',
      'do-not-contact',
      'usage',
    ])
    expect(DEFAULT_SETTINGS_SLUG).toBe('profile')
  })

  it('Brief 47 (PR 5): "Do not contact" has its own section and page', () => {
    const section = findSettingsSection('do-not-contact')
    expect(section).toMatchObject({ label: 'Do not contact' })
    expect(section?.blurb).toBeTruthy()
    expect(settingsHref('do-not-contact')).toBe('/settings/do-not-contact')
  })

  it('lights exactly one row, even when a slug prefixes another', () => {
    expect(isActiveSettingsPath('/settings/calling', 'calling')).toBe(true)
    // A startsWith test would light `calling` here too.
    expect(isActiveSettingsPath('/settings/calling-hours', 'calling')).toBe(false)
    expect(isActiveSettingsPath('/settings/profile', 'calling')).toBe(false)
  })

  it('every section resolves and every href is unique', () => {
    const hrefs = SETTINGS_SECTIONS.map((s) => settingsHref(s.slug))
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const s of SETTINGS_SECTIONS) expect(findSettingsSection(s.slug)).toBe(s)
    expect(findSettingsSection('nope')).toBeUndefined()
  })
})

describe('spend bar', () => {
  it('warns at 80% and turns danger at 95% of cap', () => {
    expect(spendTone(0, 200)).toBe('ok')
    expect(spendTone(159.99, 200)).toBe('ok')
    expect(spendTone(160, 200)).toBe('warn') // exactly 80%
    expect(spendTone(189.99, 200)).toBe('warn')
    expect(spendTone(190, 200)).toBe('danger') // exactly 95%
    expect(spendTone(250, 200)).toBe('danger')
  })

  it('treats a zero cap as danger rather than dividing by zero', () => {
    // B halts on `spend >= cap`, so a cap of 0 halts immediately; NaN here
    // would silently render an `ok` bar on a dialer that cannot dial.
    expect(spendTone(0, 0)).toBe('danger')
    expect(spendPercent(0, 0)).toBe(100)
    expect(Number.isNaN(spendPercent(5, 0))).toBe(false)
  })

  it('clamps the bar to 0-100 when the month runs over cap', () => {
    expect(spendPercent(0, 200)).toBe(0)
    expect(spendPercent(100, 200)).toBe(50)
    expect(spendPercent(400, 200)).toBe(100)
  })
})

describe('caller id masking', () => {
  it('masks the exchange of a +1 E.164 number but keeps the last four', () => {
    expect(maskCallerId('+12125550143')).toBe('+1 (212) •••-0143')
  })

  it('returns anything else verbatim so a misconfigured value stays visible', () => {
    expect(maskCallerId('')).toBe('')
    expect(maskCallerId('not-a-number')).toBe('not-a-number')
    expect(maskCallerId('+442079460750')).toBe('+442079460750') // non-NANP
  })
})

describe('window formatting', () => {
  it('renders the half-open window without advertising the closing hour', () => {
    // windowCheck blocks on `localHour >= latestHour`, so latestHour 20 means
    // 8pm is already blocked. Printing "9pm" would advertise a blocked hour.
    expect(formatWindow(9, 20)).toBe('9am–8pm')
    const at8pm = evaluateCallingWindow({
      atInstant: new Date('2026-08-27T20:30:00-04:00'), // 8:30pm ET, a Thursday
      timezone: 'America/New_York',
      earliestHour: 9,
      latestHour: 20,
      allowedDaysOfWeek: [1, 2, 3, 4, 5],
    })
    expect(at8pm.allowed).toBe(false)
    expect(at8pm.reason).toBe('outside_calling_window_hour')
  })

  it('formats hours around noon and midnight', () => {
    expect(formatHour(0)).toBe('12am')
    expect(formatHour(9)).toBe('9am')
    expect(formatHour(12)).toBe('12pm')
    expect(formatHour(20)).toBe('8pm')
  })

  it('collapses contiguous days and lists scattered ones', () => {
    expect(formatAllowedDays([1, 2, 3, 4, 5])).toBe('Mon–Fri')
    expect(formatAllowedDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day')
    expect(formatAllowedDays([1, 3, 5])).toBe('Mon, Wed, Fri')
    expect(formatAllowedDays([2, 3])).toBe('Tue, Wed')
    expect(formatAllowedDays([])).toBe('No days')
  })
})

describe('minutes', () => {
  it('keeps a decimal so short months are not rounded to zero', () => {
    expect(formatMinutes(0)).toBe('0')
    expect(formatMinutes(24)).toBe('0.4')
    expect(formatMinutes(600)).toBe('10.0')
  })
})

describe('pacing bands', () => {
  it("derives the displayed table from B's exported thresholds, not literals", () => {
    const rows = pacingBandRows()
    expect(rows).toHaveLength(5)
    expect(rows[4].action).toBe('Halt')
    // Pin the display to the control law: if B retunes a threshold, this table
    // moves with it instead of quietly describing the old behaviour.
    expect(rows[1].range).toContain((ABANDONMENT_BANDS.HOLD_FLOOR * 100).toFixed(1))
    expect(rows[4].range).toContain((ABANDONMENT_BANDS.HALT_FLOOR * 100).toFixed(1))
  })
})

describe('mailbox connection state', () => {
  it('a missing credential is not connected', () => {
    expect(isMailboxConnected(null)).toBe(false)
    expect(isMailboxConnected(undefined)).toBe(false)
  })

  it('a revoked credential is not connected even though the row survives', () => {
    // markRevoked blanks the tokens and sets status, it does NOT delete the
    // row — so "a row exists" must never be mistaken for "connected".
    expect(isMailboxConnected({ status: 'revoked' })).toBe(false)
  })

  it('an unhealthy credential is still connected, so the badge can say why', () => {
    expect(isMailboxConnected({ status: 'active' })).toBe(true)
    expect(isMailboxConnected({ status: 'reauth_required' })).toBe(true)
    expect(isMailboxConnected({ status: 'error' })).toBe(true)
  })
})

// Brief 41.2 (PR D). Ryan's instruction: Outlook stays on hard pause; switch
// name confirmed by Ryan 2026-10-17. The server reads GRAPH_ENABLED and passes
// only the resulting card state down to the page.
describe('connected accounts card while Outlook is paused', () => {
  const outlook = { key: 'outlook' as const, label: 'Outlook', authorizeHref: '/api/comms/oauth/msft/authorize' }
  const gmail = { key: 'gmail' as const, label: 'Gmail', authorizeHref: '/api/comms/oauth/gmail/authorize' }
  const paused = { graphEnabled: false }

  it('the Outlook card says "Outlook is paused" and offers no Connect link', () => {
    const card = mailboxCardActions({ ...outlook, connected: false }, paused)
    expect(card.pausedNote).toMatch(/^Outlook is paused/)
    expect(card.connect).toBeNull()
    expect(card.disconnect).toBe(false)
  })

  it('a stored Outlook connection still shows, with Disconnect but no Reconnect', () => {
    const card = mailboxCardActions({ ...outlook, connected: true }, paused)
    expect(card.disconnect).toBe(true)
    expect(card.connect).toBeNull()
    expect(card.pausedNote).toMatch(/^Outlook is paused/)
  })

  it('Gmail is unchanged', () => {
    expect(mailboxCardActions({ ...gmail, connected: false }, paused)).toEqual({
      pausedNote: null,
      connect: { label: 'Connect', href: gmail.authorizeHref },
      disconnect: false,
    })
    expect(mailboxCardActions({ ...gmail, connected: true }, paused)).toEqual({
      pausedNote: null,
      connect: { label: 'Reconnect', href: gmail.authorizeHref },
      disconnect: true,
    })
  })

  it('with GRAPH_ENABLED=true the Outlook card is as before', () => {
    expect(mailboxCardActions({ ...outlook, connected: false }, { graphEnabled: true })).toEqual({
      pausedNote: null,
      connect: { label: 'Connect', href: outlook.authorizeHref },
      disconnect: false,
    })
    expect(mailboxCardActions({ ...outlook, connected: true }, { graphEnabled: true }).connect).toEqual({
      label: 'Reconnect',
      href: outlook.authorizeHref,
    })
  })
})
