import type { MergeSources } from '@/lib/comms/templates/render'

/**
 * The merge tags offered by the template editor.
 *
 * These are the tokens Agent D's renderer actually resolves. The M4 brief listed
 * `{{first_name}}`, `{{last_name}}`, `{{property_address}}` — none of which
 * exist; `resolveMergePath` would render them as empty strings, silently. The
 * real syntax is documented at the top of `@/lib/comms/templates/render`.
 */
export interface MergeTag {
  token: string
  label: string
  /** What the preview pane substitutes, so the shape is obvious while writing. */
  sample: string
}

export const MERGE_TAGS: MergeTag[] = [
  { token: '{{contact.firstName}}', label: 'Contact first name', sample: 'Dana' },
  { token: '{{contact.displayName}}', label: 'Contact full name', sample: 'Dana Whitfield' },
  { token: '{{lead.displayName}}', label: 'Lead name', sample: 'Dana Whitfield' },
  { token: '{{lead.primaryAddressSummary}}', label: 'Property address', sample: '412 W 22nd St, Chelsea' },
  { token: '{{signature}}', label: 'Your signature', sample: 'Ryan Martin · Douglas Elliman' },
]

/** Sample data behind the preview pane. Mirrors MERGE_TAGS above. */
export const SAMPLE_SOURCES: MergeSources = {
  contact: { name: 'Dana Whitfield', displayName: 'Dana Whitfield' },
  lead: {
    displayName: 'Dana Whitfield',
    primaryAddressSummary: '412 W 22nd St, Chelsea',
    addresses: [],
  },
  custom: {},
  extra: { signature: 'Ryan Martin · Douglas Elliman' },
}

/**
 * Insert `token` into `value` at the caret, returning the new text and where the
 * caret should land. Pure so the insertion arithmetic is unit-testable — getting
 * it wrong silently eats the selection.
 */
export function insertAtCursor(
  value: string,
  token: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  return {
    value: value.slice(0, start) + token + value.slice(end),
    cursor: start + token.length,
  }
}
