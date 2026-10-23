'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import type { ColumnMapping, MappingProposal, MappingTarget } from '@/lib/core-data/importer/ai-mapping'
import {
  NOTHING_TO_MATCH,
  checkMapping,
  matchingKey,
  setColumnTarget,
  type CustomFieldChoice,
} from '@/lib/core-data/importer/mapping-edit'
import type { DuplicatePreviewDTO } from '@/lib/core-data/importer/duplicate-preview-view'
import type { TabsForReview } from '@/lib/core-data/importer/parser'
import { MappingTable } from './MappingTable'
import { DuplicatePreview, type PreviewState } from './DuplicatePreview'
import { FileTabsNote } from './FileTabsNote'

interface Proposal {
  mapping: ColumnMapping[]
  likelyDuplicates: MappingProposal['likelyDuplicates']
  coercedColumns?: { column: string }[]
  headerRow: string[]
  totalRowsDetected: number
  // Brief 50 PR 6: where the mapping came from, why, and the custom fields a
  // column may go into.
  source?: 'ai' | 'manual' | 'last-run'
  notice?: string | null
  customFields?: CustomFieldChoice[]
  // Brief 50 PR 20: an Excel file's tabs that aren't imported, and the row limit.
  tabs?: TabsForReview | null
}

// Brief 50 PR 6 (open item 6.6): Ryan changes any column's field (or "Don't
// import") before committing, sees which rows look like people already in the
// CRM, and the screen always opens: with no usable AI answer every column
// starts on "Don't import".
export default function MappingReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping[]>([])
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ status: 'blocked' })

  useEffect(() => {
    fetch(`/api/imports/${id}/proposed-mapping`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? 'Mapping failed')
        return r.json()
      })
      .then((p: Proposal) => {
        setProposal(p)
        setMapping(p.mapping)
      })
      .catch((e) => setError(e.message))
  }, [id])

  const customFields = useMemo(() => proposal?.customFields ?? [], [proposal])
  // What each column opened with: the base for "Changed" and a new field's name.
  const aiTargets = useMemo(
    () => Object.fromEntries((proposal?.mapping ?? []).map((m) => [m.column, m.target])) as Record<string, MappingTarget>,
    [proposal]
  )
  const check = useMemo(() => checkMapping(mapping, customFields), [mapping, customFields])
  const likelyDuplicates = proposal?.likelyDuplicates ?? []

  // "Already in your CRM": checked again (after a short pause) only when a
  // column that decides who a row is changes.
  const matchKey = proposal ? matchingKey(mapping) : null
  const canMatch = !check.problems.includes(NOTHING_TO_MATCH)
  useEffect(() => {
    if (matchKey === null || !canMatch) {
      setPreview({ status: 'blocked' })
      return
    }
    const ctrl = new AbortController()
    setPreview({ status: 'checking' })
    const timer = setTimeout(() => {
      fetch(`/api/imports/${id}/duplicate-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mapping: { mapping, likelyDuplicates } }),
        signal: ctrl.signal,
      })
        .then(async (r) => {
          const body = await r.json().catch(() => null)
          if (!r.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'the check failed')
          setPreview({ status: 'done', preview: body as DuplicatePreviewDTO })
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return
          setPreview({ status: 'error', error: e instanceof Error ? e.message : 'the check failed' })
        })
    }, 400)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
    // Only the columns that decide matching restart the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, matchKey, canMatch])

  async function commit() {
    if (!proposal || check.problems.length > 0) return
    setCommitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/imports/${id}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mapping: { mapping, likelyDuplicates },
          duplicateStrategy: 'merge',
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Commit failed')
      router.push(`/imports/${id}/progress`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Commit failed')
      setCommitting(false)
    }
  }

  // A <div>, not <main>: AppShell already renders the page's <main>, and a
  // nested one is invalid HTML the browser hoists out of place, producing a
  // hydration mismatch that silently kills interactivity on this subtree —
  // the file picker and Upload button did nothing. M6 FIX 1.
  return (
    <div>
      <div className="px-4 py-4">
        {/* AppShell's top bar already renders this page's title. */}
        <header className="mb-4">
          <h2 className="text-3xl font-bold text-fg">Review AI mapping</h2>
          <p className="mt-1 text-base text-muted">
            Check what each column of the file is imported as, change any that are wrong, then commit the import.
          </p>
        </header>
        {error && (
          <div className="mb-3 rounded-md bg-danger-subtle p-3 text-base text-danger" role="alert">
            {error}
            {/already (started|running|run)|still stopping/.test(error) && (
              <>
                {' '}
                <Link href={`/imports/${id}/progress`} className="underline">
                  See its progress
                </Link>
              </>
            )}
            {/no longer stored/.test(error) && (
              <>
                {' '}
                <Link href="/imports" className="underline" data-testid="upload-again">
                  Upload the file again
                </Link>
              </>
            )}
          </div>
        )}
        {!proposal && !error && <p className="text-base text-muted">Proposing column mapping…</p>}
        {proposal && (
          <>
            <p className="mb-3 text-base text-muted">{proposal.totalRowsDetected.toLocaleString('en-US')} rows detected</p>
            <FileTabsNote tabs={proposal.tabs} totalRows={proposal.totalRowsDetected} />
            {proposal.notice && (
              <p className="mb-3 rounded-md border border-line bg-elevated p-3 text-base text-fg" data-testid="mapping-notice">
                {proposal.notice}
              </p>
            )}
            {likelyDuplicates.length > 0 && (
              <div className="mb-3 text-sm text-muted">
                <p>The AI thinks these columns may hold the same thing:</p>
                <ul className="ml-4 list-disc">
                  {likelyDuplicates.map((d) => (
                    <li key={`${d.columnA}\u0000${d.columnB}`}>
                      {d.columnA} and {d.columnB}
                      {d.reason && ` (${d.reason})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <MappingTable
              mapping={mapping}
              aiTargets={aiTargets}
              customFields={customFields}
              coerced={(proposal.coercedColumns ?? []).map((c) => c.column)}
              manual={proposal.source === 'manual'}
              disabled={committing}
              onChange={(column, target) => setMapping((m) => setColumnTarget(m, column, target))}
            />
            <DuplicatePreview state={preview} />
            {(check.problems.length > 0 || check.warnings.length > 0) && (
              <ul className="mb-4 space-y-1 text-sm" data-testid="mapping-check">
                {check.problems.map((p) => (
                  <li key={p} className="text-danger">
                    {p}
                  </li>
                ))}
                {check.warnings.map((w) => (
                  <li key={w} className="text-warning">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="primary" onClick={commit} loading={committing} disabled={check.problems.length > 0}>
              {committing ? 'Committing…' : 'Commit import'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
