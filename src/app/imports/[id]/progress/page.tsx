'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { progressView, type ImportStatusView } from '@/lib/core-data/importer/progress-view'

export default function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [batch, setBatch] = useState<ImportStatusView | null>(null)

  useEffect(() => {
    let active = true
    let misses = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const res = await fetch(`/api/imports/${id}`).catch(() => null)
      if (!active) return
      if (!res || !res.ok) {
        // A blip shouldn't freeze the page; give up only after about a minute.
        if (++misses < 20) timer = setTimeout(poll, 3000)
        return
      }
      misses = 0
      const b = (await res.json()) as ImportStatusView
      if (!active) return
      setBatch(b)
      // Brief 41.1: keeps checking after a failure too (see progressView).
      const next = progressView(b).pollMs
      if (next !== null) timer = setTimeout(poll, next)
    }
    poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [id])

  const view = batch ? progressView(batch) : null

  // A <div>, not <main>: AppShell already renders the page's <main>, and a
  // nested one is invalid HTML the browser hoists out of place, producing a
  // hydration mismatch that silently kills interactivity on this subtree —
  // the file picker and Upload button did nothing. M6 FIX 1.
  return (
    <div>
      <div className="max-w-lg px-4 py-4">
        {/* AppShell's top bar already renders this page's title. */}
        <header className="mb-4">
          <h2 className="text-3xl font-bold text-fg">Import progress</h2>
        </header>
        {!batch && <p className="text-base text-muted">Loading…</p>}
        {batch && view && (
          <>
            <div
              className="mb-2 h-3 w-full overflow-hidden rounded-md bg-active"
              role="progressbar"
              aria-valuenow={view.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full bg-accent transition-all" style={{ width: `${view.percent}%` }} />
            </div>
            <p className="mb-4 text-base text-muted">
              {view.label}
              {view.showCounts && ` · ${view.percent}% · ${batch.importedRows}/${batch.totalRows} imported`}
              {view.showCounts && batch.duplicateRows > 0 && ` · ${batch.duplicateRows} merged`}
              {view.showCounts && batch.errorRows > 0 && ` · ${batch.errorRows} errors`}
            </p>
            {view.message && (
              <p className="mb-4 text-base text-danger" data-testid="import-failed">
                {view.message}
              </p>
            )}
            {(view.action === 'back' || view.action === 'upload') && (
              <Button asChild variant="primary">
                {view.action === 'upload' ? (
                  <Link href="/imports" data-testid="retry-import">
                    Upload the file again
                  </Link>
                ) : (
                  <Link href={`/imports/${id}/mapping-review`} data-testid="retry-import">
                    Back to the import
                  </Link>
                )}
              </Button>
            )}
            {view.action === 'leads' && (
              <Button asChild variant="primary">
                <Link href="/leads" data-testid="view-leads">
                  View leads
                </Link>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
