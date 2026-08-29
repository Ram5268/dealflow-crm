import { describe, it, expect } from 'vitest'
import {
  ATTENTION_LIMIT,
  dayWindow,
  previewOf,
  rankAttention,
  type AttentionItem,
} from '@/lib/focus/summary'
import { formatDuration } from '@/components/shell/useSoftphoneSession'
import { shortStamp, relativeTime } from '@/lib/ui/time'

function item(over: Partial<AttentionItem> & Pick<AttentionItem, 'kind' | 'at'>): AttentionItem {
  return {
    key: `${over.kind}:${over.at.toISOString()}`,
    title: 'Lead',
    detail: 'detail',
    href: '/leads',
    overdue: false,
    ...over,
  }
}

describe('dayWindow', () => {
  it('anchors "today" to the display timezone, not UTC', () => {
    // 2026-08-29T02:30:00Z is 10:30pm ET on Aug 28. The day must be Aug 28.
    const { start, end } = dayWindow(new Date('2026-08-29T02:30:00Z'))
    expect(start.toISOString()).toBe('2026-08-28T04:00:00.000Z') // midnight EDT
    expect(end.toISOString()).toBe('2026-08-29T04:00:00.000Z')
  })

  it('spans exactly one day', () => {
    const { start, end } = dayWindow(new Date('2026-08-29T18:00:00Z'))
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('contains the instant it was derived from', () => {
    const now = new Date('2026-08-29T23:59:00Z')
    const { start, end } = dayWindow(now)
    expect(now.getTime()).toBeGreaterThanOrEqual(start.getTime())
    expect(now.getTime()).toBeLessThan(end.getTime())
  })
})

describe('previewOf', () => {
  it('takes the first non-empty line', () => {
    expect(previewOf('\n\n  Hi Ryan  \nsecond line')).toBe('Hi Ryan')
  })

  it('returns empty string for null or blank bodies', () => {
    expect(previewOf(null)).toBe('')
    expect(previewOf('   \n  ')).toBe('')
  })

  it('truncates with an ellipsis at the limit', () => {
    const out = previewOf('x'.repeat(200), 20)
    expect(out).toHaveLength(20)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('rankAttention', () => {
  const overdueTask = item({ kind: 'task', at: new Date('2026-08-20T12:00:00Z'), overdue: true })
  const dueTask = item({ kind: 'task', at: new Date('2026-08-29T12:00:00Z') })
  const reply = item({ kind: 'reply', at: new Date('2026-08-28T12:00:00Z') })
  const callback = item({ kind: 'callback', at: new Date('2026-08-01T12:00:00Z') })

  it('puts overdue tasks above everything else', () => {
    expect(rankAttention([callback, reply, dueTask, overdueTask])[0]).toBe(overdueTask)
  })

  it('ranks a callback last even when it is the oldest item', () => {
    const ranked = rankAttention([callback, reply, dueTask, overdueTask])
    expect(ranked[ranked.length - 1]).toBe(callback)
  })

  it('breaks ties oldest-first so nothing gets buried', () => {
    const ranked = rankAttention([dueTask, reply])
    expect(ranked).toEqual([reply, dueTask]) // reply is a day older, same tier
  })

  it('does not mutate its input', () => {
    const input = [callback, overdueTask]
    rankAttention(input)
    expect(input).toEqual([callback, overdueTask])
  })

  it('caps the list at ten items', () => {
    expect(ATTENTION_LIMIT).toBe(10)
  })
})

describe('formatDuration', () => {
  it('renders m:ss with a zero-padded seconds field', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(61)).toBe('1:01')
    expect(formatDuration(3599)).toBe('59:59')
  })

  it('keeps counting past an hour rather than wrapping', () => {
    expect(formatDuration(3661)).toBe('61:01')
  })
})

describe('display timestamps', () => {
  const now = new Date('2026-08-29T18:00:00Z') // 2pm ET

  it('shows wall-clock time for today', () => {
    expect(shortStamp(new Date('2026-08-29T17:42:00Z'), now)).toBe('1:42 PM')
  })

  it('shows a date for anything older', () => {
    expect(shortStamp(new Date('2026-08-12T17:42:00Z'), now)).toBe('Aug 12')
  })

  it('returns empty string for a missing date', () => {
    expect(shortStamp(null, now)).toBe('')
    expect(relativeTime(null, now)).toBe('')
  })

  it('renders a relative phrase against the supplied base', () => {
    expect(relativeTime(new Date('2026-08-29T17:00:00Z'), now)).toBe('1 hour ago')
  })
})
