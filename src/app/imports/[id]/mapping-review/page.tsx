'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'

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
      <div className="px-4 py-4">
        {/* AppShell's top bar already renders this page's title. */}
        <header className="mb-4">
          <h2 className="text-3xl font-bold text-fg">Review AI mapping</h2>
          <p className="mt-1 text-base text-muted">
            Check each proposed column target before committing the import.
          </p>
        </header>
        {error && <div className="mb-3 rounded-md bg-danger-subtle p-3 text-base text-danger">{error}</div>}
        {!proposal && !error && <p className="text-base text-muted">Proposing column mapping…</p>}
        {proposal && (
          <>
            <p className="mb-3 text-base text-muted">{proposal.totalRowsDetected} rows detected</p>
            <div className="mb-4 overflow-x-auto border-b border-line">
              <table className="w-full border-collapse text-base">
                <thead className="bg-bg text-left">
                  <tr>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Column</th>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Samples</th>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Mapping</th>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.mapping.map((m) => (
                    <tr key={m.column} className="h-10 border-b border-line">
                      <td className="border-r border-line px-3 font-medium text-fg last:border-r-0">{m.column}</td>
                      <td className="border-r border-line px-3 text-muted last:border-r-0">{m.sampleValues.slice(0, 3).join(', ')}</td>
                      <td className="border-r border-line px-3 text-fg last:border-r-0">{targetLabel(m.target)}</td>
                      <td className="border-r border-line px-3 text-fg last:border-r-0">{Math.round(m.confidence * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button variant="primary" onClick={commit} loading={committing}>
              {committing ? 'Committing…' : 'Commit import'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
