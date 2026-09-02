'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface ColumnMapping {
  column: string
  sampleValues: string[]
  target: Record<string, unknown> & { kind: string }
  confidence: number
  reasoning: string
}
interface Proposal {
  mapping: ColumnMapping[]
  likelyDuplicates: { columnA: string; columnB: string; reason: string }[]
  headerRow: string[]
  totalRowsDetected: number
}

function targetLabel(t: ColumnMapping['target']): string {
  if (t.kind === 'standard_field') return `→ ${t.field}`
  if (t.kind === 'new_custom_field') return `+ new custom "${t.name}" (${t.type})`
  if (t.kind === 'existing_custom_field') return `→ custom ${t.definitionId}`
  return 'ignore'
}

export default function MappingReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)

  useEffect(() => {
    fetch(`/api/imports/${id}/proposed-mapping`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? 'Mapping failed')
        return r.json()
      })
      .then(setProposal)
      .catch((e) => setError(e.message))
  }, [id])

  async function commit() {
    if (!proposal) return
    setCommitting(true)
    try {
      const res = await fetch(`/api/imports/${id}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mapping: { mapping: proposal.mapping, likelyDuplicates: proposal.likelyDuplicates },
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
      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="mb-4 text-lg font-semibold">Review AI mapping</h1>
        {error && <div className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {!proposal && !error && <p className="text-sm text-neutral-500">Proposing column mapping…</p>}
        {proposal && (
          <>
            <p className="mb-3 text-sm text-neutral-500">{proposal.totalRowsDetected} rows detected</p>
            <table className="mb-4 w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
                <tr>
                  <th className="px-3 py-2">Column</th>
                  <th className="px-3 py-2">Samples</th>
                  <th className="px-3 py-2">Mapping</th>
                  <th className="px-3 py-2">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {proposal.mapping.map((m) => (
                  <tr key={m.column} className="border-t border-neutral-100">
                    <td className="px-3 py-2 font-medium">{m.column}</td>
                    <td className="px-3 py-2 text-neutral-500">{m.sampleValues.slice(0, 3).join(', ')}</td>
                    <td className="px-3 py-2">{targetLabel(m.target)}</td>
                    <td className="px-3 py-2">{Math.round(m.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={commit}
              disabled={committing}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {committing ? 'Committing…' : 'Commit import'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
