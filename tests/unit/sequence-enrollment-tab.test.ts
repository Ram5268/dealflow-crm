import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider } from '@/components/ui'
import { EnrollmentTab } from '@/app/sequences/[id]/SequenceDetailView'
import type { EnrollmentRow, SequenceDetail } from '@/lib/sequences/queries'

// Brief 41.2 (PR E): a sequence's Enrollment tab while a channel it uses is
// off. Resume is greyed out with the reason (the server refuses it anyway:
// engineering precaution, audit H15, as a resumed enrollment would fire at
// switch-on like a new one). Greyed out with the reason, not hidden, follows
// Ryan's decision of 2026-10-17 for "Add to sequence". Pause and Unenroll
// stay available. The empty state gives the reason instead of "Enroll a lead".
const REASON = "Email is off, so this sequence can't start."

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

const row = (id: string, status: string): EnrollmentRow => ({
  id,
  contactId: `c_${id}`,
  contactName: `Test contact ${id}`,
  leadId: null,
  status,
  currentStepOrdinal: 0,
  enrolledAt: '2026-10-02T12:00:00.000Z',
  nextFireAt: null,
})

const detail = (enrollments: EnrollmentRow[]): SequenceDetail => ({
  id: 'seq_1',
  name: 'New seller follow-up',
  description: null,
  channel: 'email',
  createdAt: '2026-10-01T12:00:00.000Z',
  steps: [
    {
      id: 'st1',
      ordinal: 0,
      delayHours: 0,
      channel: 'email',
      templateId: 'tpl_1',
      templateName: 'Intro',
      templateSubject: 'Hello',
      templatePreview: 'Hello there',
    },
  ],
  enrollments,
  stats: { sent: 0, failed: 0, queued: 0, replies: 0, openRate: null, bounceRate: null },
})

function render(sequence: SequenceDetail, blockedReason?: string | null): string {
  return renderToStaticMarkup(
    h(
      AppRouterContext.Provider,
      { value: router },
      h(ToastProvider, null, h(EnrollmentTab, { sequence, blockedReason })),
    ),
  )
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

/** The opening tag of every button labelled exactly `label`. */
function buttons(html: string, label: string): string[] {
  return [...html.matchAll(new RegExp(`<button([^>]*)>${label}</button>`, 'g'))].map((m) => m[1])
}
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag)

describe('EnrollmentTab empty state', () => {
  it('while the sequence cannot start, it gives the reason instead of "Enroll a lead from its detail page."', () => {
    const t = text(render(detail([]), REASON))
    expect(t).toContain('Nobody is enrolled yet.')
    expect(t).toContain(REASON)
    expect(t).not.toContain('Enroll a lead from its detail page.')
  })

  it('while it can start, the hint is as before', () => {
    for (const reason of [undefined, null]) {
      const t = text(render(detail([]), reason))
      expect(t).toContain('Enroll a lead from its detail page.')
      expect(t).not.toContain(REASON)
    }
  })
})

describe('EnrollmentTab Resume', () => {
  const rows = detail([row('a', 'paused'), row('b', 'active'), row('c', 'paused')])

  it('while the sequence cannot start: Resume is shown greyed out, with the reason; Pause and Unenroll still work', () => {
    const html = render(rows, REASON)
    const resume = buttons(html, 'Resume')
    expect(resume).toHaveLength(2)
    for (const tag of resume) expect(isDisabled(tag)).toBe(true)
    expect(buttons(html, 'Pause').map(isDisabled)).toEqual([false])
    expect(buttons(html, 'Unenroll').map(isDisabled)).toEqual([false, false, false])
    // The reason is visible text, once, and describes each Resume button.
    expect(text(html).split(REASON)).toHaveLength(2)
    const ids = new Set(resume.map((tag) => /aria-describedby="([^"]+)"/.exec(tag)?.[1]))
    expect(ids.size).toBe(1)
    const [id] = [...ids]
    expect(id).toBeTruthy()
    const reasonEl = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>([^<]*)<`).exec(html)
    expect(decode(reasonEl?.[1] ?? '')).toBe(REASON)
  })

  it('while it can start: Resume works as before, with no reason', () => {
    for (const reason of [undefined, null]) {
      const html = render(rows, reason)
      expect(buttons(html, 'Resume').map(isDisabled)).toEqual([false, false])
      expect(text(html)).not.toContain(REASON)
    }
  })

  it('with nothing paused there is no Resume, so no reason line', () => {
    const html = render(detail([row('b', 'active')]), REASON)
    expect(buttons(html, 'Resume')).toEqual([])
    expect(text(html)).not.toContain(REASON)
  })
})
