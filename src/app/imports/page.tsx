'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Field, controlBase, controlBorder } from '@/components/ui/Field'
import { cn } from '@/lib/ui/cn'

// Upload a Mojo CSV/XLSX. On success routes to the AI mapping-review screen.
export default function ImportsPage() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [sourceLabel, setSourceLabel] = useState('Mojo Export')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('sourceLabel', sourceLabel)
      const res = await fetch('/api/imports', { method: 'POST', body: form })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Upload failed')
      const { importBatchId } = await res.json()
      router.push(`/imports/${importBatchId}/mapping-review`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  // A <div>, not <main>: AppShell already renders the page's <main>, and a
  // nested one is invalid HTML the browser hoists out of place, producing a
  // hydration mismatch that silently kills interactivity on this subtree —
  // the file picker and Upload button did nothing. M6 FIX 1.
  return (
    <div>
      <div className="max-w-lg px-4 py-4">
        {/* AppShell's top bar already renders this page's title. */}
        <header className="mb-4">
          <h2 className="text-3xl font-bold text-fg">Import contacts</h2>
          <p className="mt-1 text-base text-muted">
            Upload a CSV or XLSX export; the next step proposes a column mapping for review.
          </p>
        </header>
        <form onSubmit={upload} className="space-y-4">
          <Field label="Source label" htmlFor="source-label">
            <input
              id="source-label"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              className={cn(controlBase, controlBorder(), 'h-8')}
            />
          </Field>
          <Field label="CSV or XLSX file" htmlFor="import-file">
            <input
              id="import-file"
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-base text-fg file:mr-3 file:rounded-md file:border file:border-line file:bg-elevated file:px-3 file:py-1.5 file:text-base file:font-medium file:text-fg hover:file:bg-hover"
            />
          </Field>
          {error && <p className="text-base text-danger">{error}</p>}
          <Button type="submit" variant="primary" disabled={!file} loading={busy}>
            {busy ? 'Uploading…' : 'Upload & propose mapping'}
          </Button>
        </form>
      </div>
    </div>
  )
}
