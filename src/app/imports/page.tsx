'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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

  return (
    <main>
      <div className="mx-auto max-w-lg px-4 py-6">
        <h1 className="mb-4 text-lg font-semibold">Import contacts</h1>
        <form onSubmit={upload} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-neutral-600">Source label</label>
            <input
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-neutral-600">CSV or XLSX file</label>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={!file || busy}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Uploading…' : 'Upload & propose mapping'}
          </button>
        </form>
      </div>
    </main>
  )
}
