import { describe, it, expect } from 'vitest'
import {
  peopleLine,
  rankLine,
  rankedDetail,
  noMojoLine,
  notScoredLine,
  type ImportSummaryDTO,
} from '@/lib/core-data/importer/summary-view'
import { SCORE_ERROR, fallbackText } from '@/lib/core-data/dealflow-score/messages'

// Brief 45 PR F — what the import progress page says once an upload is done
// [brief §5.7, §5.8]: how many rows became new people and how many were
// already in the CRM (and went on the list too), then whether the new people
// are ranked, still being scored, or wait for the morning update. Pure.

const list = { id: 'list_1', name: 'Expireds – Oct 2026', folderName: 'Expireds', archived: false }
const summary = (over: Partial<ImportSummaryDTO> = {}): ImportSummaryDTO => ({
  targetList: list,
  people: { new: 380, existing: 32, newWithoutMojoId: 0 },
  scoring: { state: 'done', error: null, ranked: 358, noMatch: 22, notScored: 0 },
  ...over,
})
const idle = { running: false, processed: 0, failed: null }

describe('peopleLine [brief §5.7]', () => {
  it("says the brief's sentence, word for word", () => {
    expect(peopleLine(412, { new: 380, existing: 32, newWithoutMojoId: 0 }, true)).toBe(
      '412 rows → 380 new people, 32 already in your CRM (added to this list too)',
    )
  })

  it('counts in the singular and with thousands separators', () => {
    expect(peopleLine(1, { new: 1, existing: 0, newWithoutMojoId: 0 }, true)).toBe('1 row → 1 new person')
    expect(peopleLine(2, { new: 0, existing: 1, newWithoutMojoId: 0 }, true)).toBe(
      '2 rows → 0 new people, 1 already in your CRM (added to this list too)',
    )
    expect(peopleLine(1200, { new: 1150, existing: 50, newWithoutMojoId: 0 }, true)).toBe(
      '1,200 rows → 1,150 new people, 50 already in your CRM (added to this list too)',
    )
  })

  it('leaves out "(added to this list too)" for an upload that filled no list', () => {
    expect(peopleLine(10, { new: 7, existing: 3, newWithoutMojoId: 0 }, false)).toBe('10 rows → 7 new people, 3 already in your CRM')
  })
})

describe('the ranking line [brief §5.8]', () => {
  it('"Ranked: done" once every new person was scored, or when nobody new came in', () => {
    expect(rankLine(summary(), idle)).toEqual({ tone: 'done', text: 'Ranked: done' })
    expect(rankLine(summary({ people: { new: 0, existing: 9, newWithoutMojoId: 0 }, scoring: { state: 'not_needed', error: null, ranked: 0, noMatch: 0, notScored: 0 } }), idle))
      .toEqual({ tone: 'done', text: 'Ranked: done' })
  })

  it('"Scoring the 380 new people…" while the scoring runs, with progress on big uploads', () => {
    const pending = summary({ scoring: { state: 'pending', error: null, ranked: 0, noMatch: 0, notScored: 380 } })
    expect(rankLine(pending, { running: true, processed: 0, failed: null })).toEqual({ tone: 'working', text: 'Scoring the 380 new people…' })
    // Before the page has started (or between chunks) it still reads as working.
    expect(rankLine(pending, idle)).toEqual({ tone: 'working', text: 'Scoring the 380 new people…' })
    const big = summary({ people: { new: 1200, existing: 0, newWithoutMojoId: 0 }, scoring: { state: 'pending', error: null, ranked: 0, noMatch: 0, notScored: 1200 } })
    expect(rankLine(big, { running: true, processed: 500, failed: null })).toEqual({
      tone: 'working',
      text: 'Scoring the 1,200 new people… (500 of 1,200 done)',
    })
  })

  it("the fallback when DealFlow couldn't be reached: the brief's text, word for word", () => {
    const failed = summary({ scoring: { state: 'failed', error: SCORE_ERROR.unreachable, ranked: 0, noMatch: 0, notScored: 380 } })
    expect(rankLine(failed, idle)).toEqual({
      tone: 'fallback',
      text: "Couldn't reach DealFlow just now, so the 380 new people will be ranked in tomorrow morning's update. They show “scoring…” until then.",
    })
  })

  it('the same fallback when the page itself loses the CRM mid-way (nothing recorded yet)', () => {
    const pending = summary({ scoring: { state: 'pending', error: null, ranked: 0, noMatch: 0, notScored: 380 } })
    expect(rankLine(pending, { running: false, processed: 0, failed: SCORE_ERROR.unreachable })?.text).toBe(
      fallbackText(SCORE_ERROR.unreachable, 380),
    )
  })

  it('every stored reason reads as one sentence', () => {
    for (const reason of Object.values(SCORE_ERROR)) {
      const text = fallbackText(reason, 2)
      expect(text).toMatch(/^[A-Z].*, so the 2 new people will be ranked in tomorrow morning's update\. They show “scoring…” until then\.$/)
    }
    expect(fallbackText(SCORE_ERROR.expired, 1)).toBe(
      "More than an hour has passed since this upload finished, so the new person will be ranked in tomorrow morning's update. They show “scoring…” until then.",
    )
  })

  it('an older upload whose hour passed without scoring: the morning update ranks them', () => {
    const missed = summary({ scoring: { state: 'missed', error: null, ranked: 0, noMatch: 0, notScored: 380 } })
    expect(rankLine(missed, idle)).toEqual({ tone: 'info', text: 'The new people from this upload are ranked in the morning update.' })
  })

  it('nothing to say before the import has finished', () => {
    expect(rankLine(summary({ people: null, scoring: null }), idle)).toBeNull()
  })
})

describe('the extra lines', () => {
  it("people without a Mojo ID [CONTRACT §7]: DealFlow can't rank them yet", () => {
    expect(noMojoLine(12)).toBe("12 people have no Mojo ID, so DealFlow can't rank them yet.")
    expect(noMojoLine(1)).toBe("1 person has no Mojo ID, so DealFlow can't rank them yet.")
    expect(noMojoLine(0)).toBeNull()
  })

  it('once ranked: how many got a rank and how many have no buyer match yet', () => {
    expect(rankedDetail({ state: 'done', error: null, ranked: 358, noMatch: 22, notScored: 0 })).toBe('358 ranked, 22 with no buyer match yet')
    expect(rankedDetail({ state: 'done', error: null, ranked: 1, noMatch: 0, notScored: 0 })).toBe('1 ranked')
    expect(rankedDetail({ state: 'done', error: null, ranked: 0, noMatch: 0, notScored: 0 })).toBeNull()
    expect(rankedDetail({ state: 'pending', error: null, ranked: 5, noMatch: 0, notScored: 9 })).toBeNull()
  })

  it('people DealFlow left out this time (the morning update looks at them again)', () => {
    expect(notScoredLine(3)).toBe("3 people weren't ranked this time. The morning update looks at them again.")
    expect(notScoredLine(1)).toBe("1 person wasn't ranked this time. The morning update looks at them again.")
    expect(notScoredLine(0)).toBeNull()
  })
})
