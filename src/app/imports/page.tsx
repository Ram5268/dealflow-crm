'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Field, controlBase, controlBorder } from '@/components/ui/Field'
import { cn } from '@/lib/ui/cn'
import { notifyListsChanged, useSidebarData } from '@/lib/core-data/lists/client'
import {
  choiceProblem,
  destinationFormFields,
  destinationJson,
  type DestinationChoice,
} from '@/lib/core-data/importer/destination-form'
import { DestinationStep } from './DestinationStep'

// Upload a Mojo CSV/XLSX. On success routes to the AI mapping-review screen.
//
// Brief 45 PR F (brief §5.7): first, where these people go: an existing list
// or a new one. The choice is checked before the file is sent (the lists
// API's own rules and words: a name already taken is refused here, before any
// upload), then travels with the upload; the rest of the flow is unchanged.
export default function ImportsPage() {
  const router = useRouter()
  const sidebar = useSidebarData()
  const [destination, setDestination] = useState<DestinationChoice>({ mode: 'new', name: '', folderId: '' })
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [sourceLabel, setSourceLabel] = useState('Mojo Export')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chooseDestination = (next: DestinationChoice) => {
    setDestination(next)
    setDestinationError(null)
  }

  function chooseFile(next: File | null) {
    setFile(next)
    // A new list with no name yet takes the file's name (without the extension).
    if (next && destination.mode === 'new' && destination.name.trim() === '') {
      setDestination({ ...destination, name: Array.from(next.name.replace(/\.(csv|xlsx|xls)$/i, '')).slice(0, 60).join('') })
    }
  }

  async function errorOf(res: Response, fallback: string): Promise<{ message: string; destination: boolean }> {
    const body = (await res.json().catch(() => null)) as { error?: unknown; field?: unknown } | null
    return { message: typeof body?.error === 'string' ? body.error : fallback, destination: body?.field === 'destination' }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    const problem = choiceProblem(destination)
    if (problem) {
      setDestinationError(problem)
      return
    }
    setBusy(true)
    setError(null)
    setDestinationError(null)
    try {
      // Checked first, so a refused list name never waits for the file to go up.
      const check = await fetch('/api/imports/destination', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(destinationJson(destination)),
      })
      if (!check.ok) {
        const { message, destination: here } = await errorOf(check, "That list can't be used.")
        if (here) setDestinationError(message)
        else setError(message)
        return
      }
      const form = new FormData()
      form.append('file', file)
      form.append('sourceLabel', sourceLabel)
      for (const [k, v] of destinationFormFields(destination)) form.append(k, v)
      const res = await fetch('/api/imports', { method: 'POST', body: form })
      if (!res.ok) {
        const { message, destination: here } = await errorOf(res, 'Upload failed')
        if (here) setDestinationError(message)
        else setError(message)
        return
      }
      const { importBatchId } = await res.json()
      if (destination.mode === 'new') notifyListsChanged()
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
            Choose where these people go, then upload a CSV or XLSX export; the next step proposes a column mapping for review.
          </p>
        </header>
        <form onSubmit={upload} className="space-y-6">
          <DestinationStep
            folders={sidebar.data?.folders ?? []}
            lists={sidebar.data?.lists ?? []}
            value={destination}
            onChange={chooseDestination}
            error={destinationError}
            disabled={busy}
            loading={!sidebar.data && !sidebar.error}
          />
          {sidebar.error && !sidebar.data && (
            // The store's plain-English error, then "Try again" (PR C's pattern).
            <p className="-mt-3 flex flex-wrap items-center gap-x-1.5 text-sm" data-testid="lists-load-error">
              <span className="text-danger">{sidebar.error} You can still make a new list.</span>
              <button type="button" onClick={() => void sidebar.reload()} className="text-link hover:underline">
                Try again
              </button>
            </p>
          )}
          <section aria-labelledby="import-file-heading" className="space-y-4">
            <h3 id="import-file-heading" className="text-lg font-semibold text-fg">
              The file
            </h3>
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
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                className="w-full text-base text-fg file:mr-3 file:rounded-md file:border file:border-line file:bg-elevated file:px-3 file:py-1.5 file:text-base file:font-medium file:text-fg hover:file:bg-hover"
              />
            </Field>
          </section>
          {error && <p className="text-base text-danger">{error}</p>}
          <Button type="submit" variant="primary" disabled={!file} loading={busy}>
            {busy ? 'Uploading…' : 'Upload & propose mapping'}
          </Button>
        </form>
      </div>
    </div>
  )
}
