import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider } from '@/components/ui'
import { EnrollButton } from '@/app/leads/[id]/EnrollButton'

// Brief 41.2 (PR E): on the lead page, "Add to sequence" is greyed out with a
// one-line reason while email and texting are off. Greyed out with the reason,
// not hidden, is Ryan's decision of 2026-10-17. Blocking the enrollment itself
// is an engineering precaution (audit H15); the server refuses it as well.
const REASON = "Email and texting are off, so sequences can't start."

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    h(
      AppRouterContext.Provider,
      { value: router },
      h(
        ToastProvider,
        null,
        h(EnrollButton, {
          sequences: [{ id: 'seq_1', name: 'New seller follow-up', stepCount: 2 }],
          contacts: [{ id: 'c_1', displayName: 'Primary contact' }],
          ...props,
        } as Parameters<typeof EnrollButton>[0]),
      ),
    ),
  )
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** The opening tag of the button labelled "Add to sequence". */
function addButtonTag(html: string): string {
  const m = /<button([^>]*)>(?:(?!<\/button>)[\s\S])*Add to sequence(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)
  expect(m, 'an "Add to sequence" button is rendered').not.toBeNull()
  return m![1]
}

describe('EnrollButton', () => {
  it('while sequences cannot start: the button is shown greyed out, with the reason next to it', () => {
    const html = render({ disabledReason: REASON })
    const tag = addButtonTag(html)
    expect(tag).toMatch(/\sdisabled=""/)
    // The reason is visible text, not only a hover tooltip, and it describes the button.
    const text = decode(html.replace(/<[^>]+>/g, ' '))
    expect(text).toContain(REASON)
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1]
    expect(describedBy).toBeTruthy()
    const reasonEl = new RegExp(`<[a-z]+[^>]*id="${describedBy}"[^>]*>([^<]*)<`).exec(html)
    expect(decode(reasonEl?.[1] ?? '')).toBe(REASON)
  })

  it('while a sequence can start: the button works as before, with no reason', () => {
    for (const html of [render({}), render({ disabledReason: null })]) {
      expect(addButtonTag(html)).not.toMatch(/\sdisabled=""/)
      expect(decode(html)).not.toContain(REASON)
    }
  })
})
