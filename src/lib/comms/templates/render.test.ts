import { describe, it, expect } from 'vitest'
import {
  resolveMergePath,
  renderTemplate,
  extractMergeFields,
  type MergeSources,
} from './render'

const sources: MergeSources = {
  contact: { name: 'Alice Wong', displayName: 'Alice Wong (buyer)' },
  lead: {
    displayName: 'Wong Household',
    primaryAddressSummary: '123 Bedford Ave',
    addresses: [
      { address_1: '123 Bedford Ave', city: 'Brooklyn' },
      { address_1: '9 Second St', city: 'Queens' },
    ],
  },
  custom: { est_value: 1200000, agent_note: 'hot lead' },
  extra: { signature: 'Ryan Martin\nDouglas Elliman', appointmentTime: 'Tue 3pm' },
}

describe('resolveMergePath', () => {
  it('contact.firstName → first token of Contact.name', () => {
    expect(resolveMergePath('contact.firstName', sources)).toBe('Alice')
  })

  it('contact.firstName → "" when name is null', () => {
    expect(resolveMergePath('contact.firstName', { contact: { name: null } })).toBe('')
  })

  it('contact.displayName resolves', () => {
    expect(resolveMergePath('contact.displayName', sources)).toBe('Alice Wong (buyer)')
  })

  it('lead.displayName and lead.primaryAddressSummary resolve', () => {
    expect(resolveMergePath('lead.displayName', sources)).toBe('Wong Household')
    expect(resolveMergePath('lead.primaryAddressSummary', sources)).toBe('123 Bedford Ave')
  })

  it('lead.addresses.[i].key array indexing', () => {
    expect(resolveMergePath('lead.addresses.[0].address_1', sources)).toBe('123 Bedford Ave')
    expect(resolveMergePath('lead.addresses.[1].city', sources)).toBe('Queens')
  })

  it('out-of-range array index → ""', () => {
    expect(resolveMergePath('lead.addresses.[5].city', sources)).toBe('')
  })

  it('lead.custom.<name> resolves (number coerced to string)', () => {
    expect(resolveMergePath('lead.custom.est_value', sources)).toBe('1200000')
    expect(resolveMergePath('lead.custom.agent_note', sources)).toBe('hot lead')
  })

  it('unknown custom field → ""', () => {
    expect(resolveMergePath('lead.custom.nope', sources)).toBe('')
  })

  it('signature resolves from mergeContext extra', () => {
    expect(resolveMergePath('signature', sources)).toBe('Ryan Martin\nDouglas Elliman')
  })

  it('bare ad-hoc var resolves from extra', () => {
    expect(resolveMergePath('appointmentTime', sources)).toBe('Tue 3pm')
  })

  it('missing everything → "" (never literal braces)', () => {
    expect(resolveMergePath('lead.displayName', {})).toBe('')
    expect(resolveMergePath('contact.displayName', {})).toBe('')
    expect(resolveMergePath('unknownRoot.x.y', sources)).toBe('')
  })

  it('refuses prototype access → ""', () => {
    expect(resolveMergePath('__proto__', sources)).toBe('')
    expect(resolveMergePath('constructor', sources)).toBe('')
    expect(resolveMergePath('lead.__proto__.polluted', sources)).toBe('')
    expect(resolveMergePath('lead.addresses.[0].constructor', sources)).toBe('')
  })
})

describe('renderTemplate', () => {
  it('substitutes multiple fields in one template', () => {
    const t = 'Hi {{contact.firstName}}, re {{lead.primaryAddressSummary}}. — {{signature}}'
    expect(renderTemplate(t, sources)).toBe(
      'Hi Alice, re 123 Bedford Ave. — Ryan Martin\nDouglas Elliman',
    )
  })

  it('missing merge fields render empty, not literal {{...}}', () => {
    expect(renderTemplate('Hi {{contact.firstName}}!', {})).toBe('Hi !')
    expect(renderTemplate('X {{__proto__}} Y', sources)).toBe('X  Y')
  })

  it('text mode does NOT escape values', () => {
    const s: MergeSources = { extra: { note: '<b>A & B</b>' } }
    expect(renderTemplate('{{note}}', s)).toBe('<b>A & B</b>')
  })

  it('html mode escapes merged values', () => {
    const s: MergeSources = { extra: { note: '<script>alert("x")</script> & more' } }
    expect(renderTemplate('{{note}}', s, { html: true })).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more',
    )
  })

  it('html mode does not double-escape surrounding static markup', () => {
    const s: MergeSources = { contact: { name: 'A&W' } }
    expect(renderTemplate('<p>{{contact.firstName}}</p>', s, { html: true })).toBe(
      '<p>A&amp;W</p>',
    )
  })

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('{{  contact.firstName  }}', sources)).toBe('Alice')
  })
})

describe('extractMergeFields', () => {
  it('returns the distinct field paths used', () => {
    const t = 'Hi {{contact.firstName}} {{contact.firstName}}, {{lead.custom.est_value}}'
    expect(extractMergeFields(t).sort()).toEqual(
      ['contact.firstName', 'lead.custom.est_value'].sort(),
    )
  })

  it('returns [] when no merge fields present', () => {
    expect(extractMergeFields('plain text, no fields')).toEqual([])
  })
})
