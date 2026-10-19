import { describe, it, expect, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import {
  DO_NOT_CONTACT_ADDED_BY,
  DO_NOT_CONTACT_ENDPOINT,
  DO_NOT_CONTACT_ROW_CAP,
  OPT_OUT_MESSAGES,
  formatAddedDate,
  last4Of,
  maskedPhone,
  readDoNotContactList,
  redactPhoneNumbers,
  submitOptOut,
  toOptOutRow,
  type DoNotContactDb,
  type DoNotContactList,
  type OptOutOutcome,
} from '@/lib/settings/doNotContact'
import { DoNotContactView } from '@/app/settings/do-not-contact/DoNotContactView'
import { OptOutOutcomeLine } from '@/app/settings/do-not-contact/OptOutForm'

// Brief 47 (PR 5): Settings → Do not contact. Ryan adds an opt-out himself and
// sees the list. Only the last 4 digits of a stored number may leave the server
// [engineering precaution]; there is no remove button [engineering precaution].
// Fictional numbers only (555-0100 to 555-0199).

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
const render = (el: ReturnType<typeof h>) => renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, el))
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\u2019/g, "'").replace(/\s+/g, ' ')

// Every way the full fictional numbers below could appear in a page.
const FULL_FORMS = ['2125550123', '212-555-0123', '212 555 0123', '555-0123', '5550123', '7185550145', '718-555-0145', '5550145']
const expectNoFullNumber = (payload: string) => {
  for (const form of FULL_FORMS) expect(payload, `"${form}" must not be in the page`).not.toContain(form)
}

describe('the list shows the last 4 digits only', () => {
  it('last4Of reads the last 4 digits of any stored form', () => {
    expect(last4Of('+12125550123')).toBe('0123')
    expect(last4Of('2125550123')).toBe('0123') // stored before Brief 41's backfill
    expect(last4Of('12125550123')).toBe('0123')
    expect(last4Of('(212) 555-0123')).toBe('0123')
    expect(last4Of('5550123')).toBe('0123')
  })

  it('a short or odd stored value shows no digits at all', () => {
    for (const odd of ['', '   ', null, undefined, '0123', '123456', 'notaphone', '+1', 'ext. 12']) {
      expect(last4Of(odd), String(odd)).toBeNull()
    }
    expect(maskedPhone(null)).toBe('••••')
    expect(maskedPhone('0123')).toBe('•••• 0123')
  })

  it('a row becomes the last 4 digits, the reason and the date, nothing else', () => {
    const row = toOptOutRow({ phone: '+12125550123', reason: 'Asked on a call', addedAt: new Date('2026-10-19T14:00:00Z') })
    expect(row).toEqual({ last4: '0123', reason: 'Asked on a call', addedAt: '2026-10-19T14:00:00.000Z' })
    expectNoFullNumber(JSON.stringify(row))
  })

  it('no reason is null; the STOP codes read as plain English', () => {
    const at = new Date('2026-10-19T14:00:00Z')
    expect(toOptOutRow({ phone: '+12125550123', reason: null, addedAt: at }).reason).toBeNull()
    expect(toOptOutRow({ phone: '+12125550123', reason: '  ', addedAt: at }).reason).toBeNull()
    expect(toOptOutRow({ phone: '+12125550123', reason: 'sms_stop_received', addedAt: at }).reason).toBe('Texted STOP')
    expect(toOptOutRow({ phone: '+12125550123', reason: 'sms_stop_phrase', addedAt: at }).reason).toBe(
      'A text with a stop word in it',
    )
  })

  it('a number typed into a reason is masked too', () => {
    expect(redactPhoneNumbers('Asked by text from 212-555-0123')).toBe('Asked by text from •••• 0123')
    expect(redactPhoneNumbers('Wife (212) 555-0123 asked')).toBe('Wife •••• 0123 asked')
    expect(redactPhoneNumbers('+1 212 555 0123 and 718.555.0145')).toBe('•••• 0123 and •••• 0145')
    expect(redactPhoneNumbers('Local 555-0123')).toBe('Local •••• 0123')
    // Dates and small numbers are left alone.
    expect(redactPhoneNumbers('Called 3 times, 10/19/2026')).toBe('Called 3 times, 10/19/2026')
    expect(redactPhoneNumbers('Asked on 2026-10-19')).toBe('Asked on 2026-10-19')
    const row = toOptOutRow({ phone: '+12125550123', reason: 'Texted from 212-555-0123', addedAt: new Date() })
    expectNoFullNumber(JSON.stringify(row))
  })

  it('a number pasted with a slash, an underscore or a Unicode dash is masked too', () => {
    const forms = ['212/555/0123', '212_555_0123', '212\u2013555\u20130123', '212\u2011555\u20110123', '\uff12\uff11\uff12\uff15\uff15\uff15\uff10\uff11\uff12\uff13']
    for (const f of forms) expect(redactPhoneNumbers(`Wife ${f} too`), f).toMatch(/^Wife ••••( 0123)? too$/)
    expect(redactPhoneNumbers('Called 10/19/2026')).toBe('Called 10/19/2026')
  })

  it('a reason that is an Object.prototype key is shown as typed', () => {
    for (const r of ['constructor', 'toString', '__proto__']) {
      expect(toOptOutRow({ phone: '+12125550123', reason: r, addedAt: new Date() }).reason, r).toBe(r)
    }
  })

  it('the date added is shown as a New York calendar date', () => {
    expect(formatAddedDate('2026-10-19T14:00:00.000Z')).toBe('Oct 19, 2026')
    expect(formatAddedDate('2026-10-19T02:00:00.000Z')).toBe('Oct 18, 2026') // 10 pm the evening before in New York
  })
})

type Stored = { id: string; organizationId: string; source: string; phone: string; reason: string | null; addedAt: Date }

/** A fake DncSuppression table that applies the where / orderBy / take it is given. */
function fakeDb(rows: Stored[], opts: { total?: number } = {}) {
  const calls = { count: [] as any[], findMany: [] as any[] }
  const match = (where: any) => (r: Stored) =>
    Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)
  const db: DoNotContactDb = {
    dncSuppression: {
      count: async (args: any) => {
        calls.count.push(args)
        return opts.total ?? rows.filter(match(args.where)).length
      },
      findMany: async (args: any) => {
        calls.findMany.push(args)
        expect(args.orderBy[0]).toEqual({ addedAt: 'desc' })
        return rows
          .filter(match(args.where))
          .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
          .slice(0, args.take)
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, (r as Record<string, unknown>)[k]])) as any)
      },
    },
  }
  return { db, calls }
}

const STORED: Stored[] = [
  { id: 'd1', organizationId: 'org_1', source: 'internal', phone: '+12125550123', reason: 'Asked on a call', addedAt: new Date('2026-10-01T15:00:00Z') },
  { id: 'd2', organizationId: 'org_1', source: 'internal', phone: '+17185550145', reason: 'sms_stop_received', addedAt: new Date('2026-10-19T14:00:00Z') },
  // Not this screen's: the federal registry, and another organization.
  { id: 'd3', organizationId: 'org_1', source: 'federal', phone: '+12125550111', reason: null, addedAt: new Date('2026-10-18T14:00:00Z') },
  { id: 'd4', organizationId: 'org_2', source: 'internal', phone: '+12125550122', reason: null, addedAt: new Date('2026-10-18T14:00:00Z') },
]

describe('the list query', () => {
  it("reads this organization's internal opt-outs only, newest first, capped", async () => {
    const { db, calls } = fakeDb(STORED)
    const list = await readDoNotContactList(db, 'org_1')
    for (const args of [...calls.count, ...calls.findMany]) {
      expect(args.where).toEqual({ organizationId: 'org_1', source: 'internal' })
    }
    expect(calls.findMany[0].take).toBe(DO_NOT_CONTACT_ROW_CAP)
    expect(DO_NOT_CONTACT_ROW_CAP).toBe(200)
    expect(list).toEqual({
      total: 2,
      capped: false,
      rows: [
        { last4: '0145', reason: 'Texted STOP', addedAt: '2026-10-19T14:00:00.000Z' },
        { last4: '0123', reason: 'Asked on a call', addedAt: '2026-10-01T15:00:00.000Z' },
      ],
    })
    expectNoFullNumber(JSON.stringify(list))
  })

  it('says it is capped when there are more than it shows', async () => {
    const { db } = fakeDb(STORED, { total: 250 })
    const list = await readDoNotContactList(db, 'org_1')
    expect(list.total).toBe(250)
    expect(list.capped).toBe(true)
  })
})

const LIST: DoNotContactList = {
  total: 2,
  capped: false,
  rows: [
    { last4: '0145', reason: 'Texted STOP', addedAt: '2026-10-19T14:00:00.000Z' },
    { last4: '0123', reason: null, addedAt: '2026-10-01T15:00:00.000Z' },
  ],
}

describe('the page', () => {
  it('shows each opt-out as its last 4 digits, the reason (or —) and the date; never the full number', async () => {
    const { db } = fakeDb(STORED)
    const html = render(h(DoNotContactView, { list: await readDoNotContactList(db, 'org_1') }))
    const t = text(html)
    expect(t).toContain('Do not contact')
    expect(t).toMatch(/•••• 0145 Texted STOP Oct 19, 2026/)
    expect(t).toMatch(/•••• 0123 Asked on a call Oct 1, 2026/)
    expect(t).toMatch(/On the list 2\b/)
    expectNoFullNumber(html)
  })

  it('an empty reason shows a dash', () => {
    expect(text(render(h(DoNotContactView, { list: LIST })))).toMatch(/•••• 0123 — Oct 1, 2026/)
  })

  it('says what an opt-out does, and that removing one is not possible here', () => {
    const t = text(render(h(DoNotContactView, { list: LIST })))
    expect(t).toContain("won't call or text a number on this list")
    expect(t).toContain('There is no remove button')
  })

  it('has the add form and no remove button', () => {
    const html = render(h(DoNotContactView, { list: LIST }))
    expect(html).toMatch(/<form[^>]*data-opt-out-form/)
    expect(html).toMatch(/<input[^>]*name="phone"/)
    expect(html).toMatch(/<input[^>]*name="reason"/)
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim())
    expect(buttons).toEqual(['Add to the list'])
  })

  it('a capped list says how many it shows', () => {
    const t = text(render(h(DoNotContactView, { list: { ...LIST, total: 250, capped: true } })))
    expect(t).toContain('Showing the newest 2 of 250.')
  })

  it('an empty list says so', () => {
    const t = text(render(h(DoNotContactView, { list: { total: 0, capped: false, rows: [] } })))
    expect(t).toContain('No numbers on the list yet.')
    expect(t).toMatch(/On the list 0\b/)
  })
})

/** A fake fetch answering with one status and body; records what was sent. */
function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  )
}
const routeReply = (added: boolean) => ({ id: 'dnc_1', phone: '+12125550123', source: 'internal', addedAt: '2026-10-19T14:00:00.000Z', added })
const isSuccess = (o: OptOutOutcome) => o.kind === 'added' || o.kind === 'already'

describe('adding a number', () => {
  it('posts the typed number, the reason and who added it to the existing route', async () => {
    const f = fakeFetch(201, routeReply(true))
    await submitOptOut({ phone: ' 212-555-0123 ', reason: ' Asked on a call ' }, f)
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(DO_NOT_CONTACT_ENDPOINT)
    expect(DO_NOT_CONTACT_ENDPOINT).toBe('/api/compliance/dnc/internal')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ phone: '212-555-0123', reason: 'Asked on a call', addedBy: DO_NOT_CONTACT_ADDED_BY })
    expect(DO_NOT_CONTACT_ADDED_BY).toBe('settings-do-not-contact')
  })

  it('a blank reason is left out', async () => {
    const f = fakeFetch(201, routeReply(true))
    await submitOptOut({ phone: '212-555-0123', reason: '   ' }, f)
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ phone: '212-555-0123', addedBy: DO_NOT_CONTACT_ADDED_BY })
  })

  it('a refused bad number (400) shows the plain-English error and does not claim success', async () => {
    const outcome = await submitOptOut({ phone: 'call me maybe' }, fakeFetch(400, { error: 'phone is not a valid phone number' }))
    expect(outcome).toEqual({ kind: 'invalid', message: "That doesn't look like a phone number." })
    expect(isSuccess(outcome)).toBe(false)
    const html = render(h(OptOutOutcomeLine, { outcome }))
    expect(html).toMatch(/role="alert"/)
    expect(text(html)).toContain("That doesn't look like a phone number.")
    expect(text(html)).not.toMatch(/added|already/i)
  })

  it('201 with added:false says it is already on the list', async () => {
    const outcome = await submitOptOut({ phone: '212-555-0123' }, fakeFetch(201, routeReply(false)))
    expect(outcome.kind).toBe('already')
    expect(outcome.message).toBe('Already on the list (•••• 0123).')
    const html = render(h(OptOutOutcomeLine, { outcome }))
    expect(html).toMatch(/role="status"/)
    expect(text(html)).toContain('Already on the list')
    expectNoFullNumber(html)
  })

  it('201 with added:true says it was added', async () => {
    const outcome = await submitOptOut({ phone: '212-555-0123' }, fakeFetch(201, routeReply(true)))
    expect(outcome).toEqual({ kind: 'added', message: "Added •••• 0123. This CRM won't call or text it." })
  })

  it('any other answer is a generic error, never success', async () => {
    const cases: Array<[string, ReturnType<typeof fakeFetch> | typeof fetch]> = [
      ['500', fakeFetch(500, { error: 'internal_error' })],
      ['401', fakeFetch(401, 'Unauthorized')],
      ['503', fakeFetch(503, 'not configured')],
      ['200 instead of 201', fakeFetch(200, routeReply(true))],
      ['201 that is not the route reply', fakeFetch(201, '<html>oops</html>')],
      ['201 without added', fakeFetch(201, { id: 'x', phone: '+12125550123', source: 'internal' })],
      ['network failure', (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch],
    ]
    for (const [name, f] of cases) {
      const outcome = await submitOptOut({ phone: '212-555-0123' }, f)
      expect(outcome, name).toEqual({ kind: 'error', message: OPT_OUT_MESSAGES.error })
      expect(text(render(h(OptOutOutcomeLine, { outcome }))), name).not.toMatch(/added|already/i)
    }
  })

  it('an empty number is not sent', async () => {
    const f = fakeFetch(201, routeReply(true))
    expect(await submitOptOut({ phone: '   ' }, f)).toEqual({ kind: 'empty', message: OPT_OUT_MESSAGES.empty })
    expect(f).not.toHaveBeenCalled()
  })

  it('nothing shows before the form is used', () => {
    expect(render(h(OptOutOutcomeLine, { outcome: null }))).toBe('')
  })
})
