import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTimeline } from '@/app/leads/[id]/ActivityTimeline'

// Brief 45 PR C — group changes on the lead's timeline [brief §5.3; CONTRACT
// §5]: PR A's API writes an Activity of type 'Group' whose text is "Added to
// Hot" / "Removed from Nurture"; the timeline shows that text as the entry
// ("Added to Hot · Oct 18, 3:42 pm"). Other entries look as before.

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const render = (items: Parameters<typeof ActivityTimeline>[0]['items']) => renderToStaticMarkup(h(ActivityTimeline, { items }))

describe('the timeline', () => {
  const at = '2026-10-18T19:42:00.000Z'
  it('shows group changes as their text', () => {
    const html = render([
      { id: 'a1', type: 'Group', activityAt: at, bodyText: 'Added to Hot' },
      { id: 'a2', type: 'Group', activityAt: at, bodyText: 'Removed from Nurture' },
      { id: 'a3', type: 'Group', activityAt: at, bodyText: 'Removed from Old (group deleted)' },
    ])
    const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1])
    expect(items).toHaveLength(3)
    expect(items.map((i) => text(i.replace(/<time[\s\S]*?<\/time>/, '')))).toEqual([
      'Added to Hot',
      'Removed from Nurture',
      'Removed from Old (group deleted)',
    ])
    for (const i of items) expect(i).toMatch(new RegExp(`<time[^>]*dateTime="${at}"`, 'i'))
    expect(text(html)).not.toMatch(/\bGroup\b/)
  })

  it('other entries look as before: the type, then the text', () => {
    const html = render([{ id: 'c1', type: 'Call', activityAt: at, bodyText: 'Left a message' }])
    expect(text(html.replace(/<time[\s\S]*?<\/time>/, ''))).toBe('Call Left a message')
  })
})
