'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'

interface Batch {
  status: string
  progress: number
  totalRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  errorRows: number
  errorLog?: Array<{ row: number; message: string }>
}

// Plain words for a failed import (Brief 41: a failed commit now stops at
// 'failed' instead of polling forever).
function failureText(batch: Batch): string {
  const reason = batch.errorLog?.find((e) => e.row === 0)?.message.replace(/^Import stopped: /, '') ?? 'unknown error'
  if (/no stored bytes/.test(reason)) {
    return "The uploaded file is no longer stored (uploads older than a day are cleared), so this import can't run. Please upload the file again."
  }
  if (/^time limit reached/.test(reason)) {
    return `The import ran out of time (${reason.replace(/\. Run it again.*$/, '')}). Rows imported so far are kept. Run it again and it continues from there; nothing will be duplicated.`
  }
  if (/stopped responding/.test(reason)) {
    return 'The import stopped responding. Rows imported so far are kept. Run it again and it continues from there.'
  }
  return `The import stopped: ${reason}. Rows imported before it stopped are kept. You can run it again.`
}

export default function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [batch, setBatch] = useState<Batch | null>(null)

  useEffect(() => {
    let active = true
    let misses = 0
    const poll = async () => {
      const res = await fetch(`/api/imports/${id}`).catch(() => null)
      if (!res || !res.ok) {
        // A blip shouldn't freeze the page; give up only after about a minute.
        if (active && ++misses < 20) setTimeout(poll, 3000)
        return
      }
      misses = 0
      const b = (await res.json()) as Batch
      if (!active) return
      setBatch(b)
      if (b.status !== 'completed' && b.status !== 'failed') setTimeout(poll, 1500)
    }
    poll()
    return () => {
      active = false
    }
  }, [id])

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
        {batch && (
          <>
            <div
              className="mb-2 h-3 w-full overflow-hidden rounded-md bg-active"
              role="progressbar"
              aria-valuenow={batch.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full bg-accent transition-all" style={{ width: `${batch.progress}%` }} />
            </div>
            <p className="mb-4 text-base text-muted">
              {batch.status} · {batch.progress}% · {batch.importedRows}/{batch.totalRows} imported
              {batch.duplicateRows > 0 && ` · ${batch.duplicateRows} merged`}
              {batch.errorRows > 0 && ` · ${batch.errorRows} errors`}
            </p>
            {batch.status === 'failed' && (
              <p className="mb-4 text-base text-danger" data-testid="import-failed">
                {failureText(batch)}
              </p>
            )}
            {batch.status === 'failed' && (
              <Button asChild variant="primary">
                {/no stored bytes/.test(JSON.stringify(batch.errorLog ?? [])) ? (
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
            {batch.status === 'completed' && (
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
