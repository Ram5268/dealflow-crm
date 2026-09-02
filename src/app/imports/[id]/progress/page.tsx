'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'

interface Batch {
  status: string
  progress: number
  totalRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  errorRows: number
}

export default function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [batch, setBatch] = useState<Batch | null>(null)

  useEffect(() => {
    let active = true
    const poll = async () => {
      const res = await fetch(`/api/imports/${id}`)
      if (!res.ok) return
      const b = (await res.json()) as Batch
      if (!active) return
      setBatch(b)
      if (b.status !== 'completed') setTimeout(poll, 1500)
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
      <div className="mx-auto max-w-lg px-4 py-6">
        <h1 className="mb-4 text-lg font-semibold">Import progress</h1>
        {!batch && <p className="text-sm text-neutral-500">Loading…</p>}
        {batch && (
          <>
            <div className="mb-2 h-3 w-full overflow-hidden rounded bg-neutral-100">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${batch.progress}%` }} />
            </div>
            <p className="mb-4 text-sm text-neutral-600">
              {batch.status} · {batch.progress}% · {batch.importedRows}/{batch.totalRows} imported
              {batch.duplicateRows > 0 && ` · ${batch.duplicateRows} merged`}
              {batch.errorRows > 0 && ` · ${batch.errorRows} errors`}
            </p>
            {batch.status === 'completed' && (
              <Link href="/leads" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white" data-testid="view-leads">
                View leads
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  )
}
