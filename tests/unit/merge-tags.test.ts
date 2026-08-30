import { describe, it, expect } from 'vitest'
import { renderTemplate } from '@/lib/comms/templates/render'
import { MERGE_TAGS, SAMPLE_SOURCES, insertAtCursor } from '@/lib/templates/mergeTags'

describe('MERGE_TAGS', () => {
  it('every advertised tag actually resolves — none render empty', () => {
    // The trap this pins: `resolveMergePath` returns "" for an unknown path, so
    // an editor offering a tag D cannot resolve fails SILENTLY. The M4 brief
    // listed {{first_name}} / {{last_name}} / {{property_address}}, all of which
    // would have done exactly that.
    for (const tag of MERGE_TAGS) {
      const out = renderTemplate(tag.token, SAMPLE_SOURCES)
      expect(out, `${tag.token} resolved to empty`).not.toBe('')
      expect(out).toBe(tag.sample)
    }
  })

  it('the brief\'s tags would NOT have resolved (regression guard)', () => {
    for (const bogus of ['{{first_name}}', '{{last_name}}', '{{property_address}}']) {
      expect(renderTemplate(bogus, SAMPLE_SOURCES)).toBe('')
    }
  })

  it('renders a full body with several tags', () => {
    const out = renderTemplate(
      'Hi {{contact.firstName}}, about {{lead.primaryAddressSummary}} — {{signature}}',
      SAMPLE_SOURCES,
    )
    expect(out).toBe('Hi Dana, about 412 W 22nd St, Chelsea — Ryan Martin · Douglas Elliman')
  })
})

describe('insertAtCursor', () => {
  it('inserts at the caret', () => {
    expect(insertAtCursor('Hi , welcome', '{{x}}', 3, 3)).toEqual({
      value: 'Hi {{x}}, welcome',
      cursor: 8,
    })
  })

  it('replaces the current selection', () => {
    expect(insertAtCursor('Hi NAME!', '{{x}}', 3, 7)).toEqual({ value: 'Hi {{x}}!', cursor: 8 })
  })

  it('appends at the end of an empty field', () => {
    expect(insertAtCursor('', '{{x}}', 0, 0)).toEqual({ value: '{{x}}', cursor: 5 })
  })

  it('clamps out-of-range offsets instead of corrupting the text', () => {
    // A stale selection index must never drop characters.
    expect(insertAtCursor('abc', '!', 99, 99)).toEqual({ value: 'abc!', cursor: 4 })
    expect(insertAtCursor('abc', '!', -5, -5)).toEqual({ value: '!abc', cursor: 1 })
  })

  it('collapses a reversed selection to a caret insert, losing nothing', () => {
    // end is clamped up to start, so a backwards selection inserts at `start`
    // and keeps the tail. Deleting 'ef' here would be the bug.
    expect(insertAtCursor('abcdef', 'X', 4, 2)).toEqual({ value: 'abcdXef', cursor: 5 })
  })
})
