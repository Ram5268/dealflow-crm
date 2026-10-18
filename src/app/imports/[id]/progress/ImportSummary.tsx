import Link from 'next/link'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/lib/ui/cn'
import {
  noMojoLine,
  notScoredLine,
  peopleLine,
  rankLine,
  rankedDetail,
  type ImportSummaryDTO,
  type LiveScoring,
  type RankLine,
} from '@/lib/core-data/importer/summary-view'

// Brief 45 PR F — the summary under a finished import [brief §5.7, §5.8]:
//   412 rows → 380 new people, 32 already in your CRM (added to this list too)
//   List: Expireds – Oct 2026 · in Expireds
//   Ranked: done   |   Scoring the 380 new people…   |   why they wait for the morning
// The words come from summary-view.ts (pure, unit-tested).

const TONE: Record<RankLine['tone'], string> = {
  done: 'text-success',
  working: 'text-fg',
  fallback: 'text-warning',
  info: 'text-muted',
}

export function ImportSummary({ summary, totalRows, live }: { summary: ImportSummaryDTO; totalRows: number; live: LiveScoring }) {
  if (!summary.people) return null
  const rank = rankLine(summary, live)
  const detail = summary.scoring ? rankedDetail(summary.scoring) : null
  const extra = [
    noMojoLine(summary.people.newWithoutMojoId),
    summary.scoring?.state === 'done' ? notScoredLine(summary.scoring.notScored) : null,
  ].filter((line): line is string => line !== null)
  const list = summary.targetList

  return (
    <section aria-label="Upload summary" data-testid="import-summary" className="mb-4 space-y-1.5 rounded-md border border-line bg-elevated p-3">
      <p className="text-base font-medium text-fg">{peopleLine(totalRows, summary.people, !!list)}</p>
      {list && (
        <p className="text-sm text-muted">
          List:{' '}
          <Link href={`/lists/${list.id}`} className="text-link hover:underline">
            {list.name}
          </Link>
          {list.folderName && ` · in ${list.folderName}`}
          {list.archived && ' · archived'}
        </p>
      )}
      {rank && (
        <p role="status" data-testid="rank-line" className={cn('flex items-start gap-2 text-sm', TONE[rank.tone])}>
          {rank.tone === 'working' && <Spinner className="mt-0.5 shrink-0" />}
          <span>
            {rank.text}
            {detail && <span className="text-muted"> ({detail})</span>}
          </span>
        </p>
      )}
      {extra.map((line) => (
        <p key={line} className="text-sm text-muted">
          {line}
        </p>
      ))}
    </section>
  )
}
