import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GROUP_COLORS } from '@/lib/core-data/lists/types'
import { GROUP_COLOR_OPTIONS, groupColorStyle } from '@/lib/ui/groupColors'

// Brief 45 PR B — group colors are theme tokens (docs/ui-notes.md: never raw
// colors), defined for light AND dark, and one map from a group's color to its
// classes that the sidebar, the list pages, the group chips (PR C) and the
// Pipeline (PR D) all use.
const css = readFileSync(fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)), 'utf8')

/** The declarations inside the first block that starts with `selector {`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

describe('group colors', () => {
  it('every color the API accepts has a style, a plain label, and only token classes', () => {
    expect(GROUP_COLOR_OPTIONS.map((o) => o.value)).toEqual([...GROUP_COLORS])
    for (const c of GROUP_COLORS) {
      const s = groupColorStyle(c)
      expect(s.label).toMatch(/^[A-Z][a-z]+$/)
      expect(s.dot).toBe(`bg-group-${c}`)
      expect(s.chip).toBe(`bg-group-${c}-subtle text-group-${c}-fg`)
      expect(s.border).toBe(`border-group-${c}`)
    }
  })

  it('an unknown color falls back to gray instead of breaking', () => {
    expect(groupColorStyle('chartreuse')).toEqual(groupColorStyle('gray'))
    expect(groupColorStyle(null)).toEqual(groupColorStyle('gray'))
  })

  it('globals.css defines each token in both themes and exposes it to Tailwind', () => {
    const light = block(':root')
    const dark = block('[data-theme="dark"]')
    const theme = block('@theme inline')
    for (const c of GROUP_COLORS) {
      for (const suffix of ['', '-subtle', '-fg']) {
        const token = `--group-${c}${suffix}:`
        expect(light, `light ${token}`).toContain(token)
        expect(dark, `dark ${token}`).toContain(token)
        expect(theme, `@theme ${token}`).toContain(`--color-group-${c}${suffix}: var(--group-${c}${suffix});`)
      }
    }
  })
})
