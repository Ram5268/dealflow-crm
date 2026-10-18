// Brief 45 (PR F): the words the import progress page shows once an upload is
// done [brief §5.7, §5.8]:
//   "412 rows → 380 new people, 32 already in your CRM (added to this list too)"
//   then "Ranked: done", or "Scoring the 380 new people…" while DealFlow ranks
//   them, or why they wait for tomorrow morning's update.
// Pure and browser-safe, so it is tested without a browser.
import { SCORE_ERROR, count, fallbackText, theNewPeople } from '@/lib/core-data/dealflow-score/messages'

/**
 * not_needed: nobody new came in (everyone was already in the CRM);
 * pending: the page is (or will be) sending the new people to DealFlow;
 * done: every new person was sent and the answers written;
 * failed: DealFlow couldn't rank them (the reason is kept);
 * missed: the hour for ranking right away passed without a try (an upload made
 * before this feature, or a page closed straight after the import).
 */
export type ScoringState = 'not_needed' | 'pending' | 'done' | 'failed' | 'missed'

export interface ImportScoringDTO {
  state: ScoringState
  /** Plain English (dealflow-score/messages.ts), when state is 'failed'. */
  error: string | null
  /** New people DealFlow scored after this upload: with a rank, and with no buyer match. */
  ranked: number
  noMatch: number
  /** New people with a Mojo ID that DealFlow hasn't scored (yet). */
  notScored: number
}

export interface ImportSummaryDTO {
  /** The list the upload fills; null for an upload made before lists existed (or a deleted list). */
  targetList: { id: string; name: string; folderName: string | null; archived: boolean } | null
  /** Once the import has completed: people, not rows (two rows for one person are one person). */
  people: { new: number; existing: number; newWithoutMojoId: number } | null
  scoring: ImportScoringDTO | null
}

/** What the page itself knows while it drives the scoring. */
export interface LiveScoring {
  running: boolean
  /** New people sent to DealFlow so far by this page (scored or skipped). */
  processed: number
  /** The page lost the CRM mid-way (the reason it shows), with nothing recorded yet. */
  failed: string | null
}

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

/** "412 rows → 380 new people, 32 already in your CRM (added to this list too)" */
export function peopleLine(totalRows: number, people: NonNullable<ImportSummaryDTO['people']>, hasList: boolean): string {
  const parts = [plural(people.new, 'new person', 'new people')]
  if (people.existing > 0) parts.push(`${count(people.existing)} already in your CRM${hasList ? ' (added to this list too)' : ''}`)
  return `${plural(totalRows, 'row', 'rows')} → ${parts.join(', ')}`
}

export interface RankLine {
  tone: 'done' | 'working' | 'fallback' | 'info'
  text: string
}

export function rankLine(summary: ImportSummaryDTO, live: LiveScoring): RankLine | null {
  const { scoring, people } = summary
  if (!scoring || !people) return null
  const n = people.new
  switch (scoring.state) {
    case 'done':
    case 'not_needed':
      return { tone: 'done', text: 'Ranked: done' }
    case 'failed':
      return { tone: 'fallback', text: fallbackText(scoring.error ?? SCORE_ERROR.unreachable, n) }
    case 'missed':
      return { tone: 'info', text: 'The new people from this upload are ranked in the morning update.' }
    case 'pending': {
      if (live.failed) return { tone: 'fallback', text: fallbackText(live.failed, n) }
      const progress = live.processed > 0 && live.processed < n ? ` (${count(live.processed)} of ${count(n)} done)` : ''
      return { tone: 'working', text: `Scoring ${theNewPeople(n)}…${progress}` }
    }
  }
}

/** "358 ranked, 22 with no buyer match yet", once ranked. */
export function rankedDetail(scoring: ImportScoringDTO): string | null {
  if (scoring.state !== 'done') return null
  const parts: string[] = []
  if (scoring.ranked > 0) parts.push(`${count(scoring.ranked)} ranked`)
  if (scoring.noMatch > 0) parts.push(`${count(scoring.noMatch)} with no buyer match yet`)
  return parts.length ? parts.join(', ') : null
}

/**
 * DealFlow's lead copy keys on the Mojo ID, so it can't rank people without one,
 * not even overnight (CONTRACT §7, until Ryan decides on a stand-in key).
 */
export function noMojoLine(n: number): string | null {
  if (n <= 0) return null
  return `${n === 1 ? '1 person has' : `${count(n)} people have`} no Mojo ID, so DealFlow can't rank them yet.`
}

/** New people DealFlow left out this time (e.g. their name and street match two records). */
export function notScoredLine(n: number): string | null {
  if (n <= 0) return null
  return `${n === 1 ? "1 person wasn't" : `${count(n)} people weren't`} ranked this time. The morning update looks at them again.`
}
