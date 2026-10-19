import { Spinner } from '@/components/ui/Spinner'
import {
  duplicateHeadline,
  matchLine,
  moreLine,
  unidentifiedLine,
  type DuplicatePreviewDTO,
} from '@/lib/core-data/importer/duplicate-preview-view'

// Brief 50 PR 6 (open item 6.6): before the commit, which rows look like
// people already in the CRM, with a short list (name, the last 4 digits of the
// phone, and the lead it merges into, which opens in a new tab). The words come
// from duplicate-preview-view.ts (pure, unit-tested). Read-only.

export type PreviewState =
  | { status: 'blocked' } // no column can match rows yet: nothing to check
  | { status: 'checking' }
  | { status: 'error'; error: string }
  | { status: 'done'; preview: DuplicatePreviewDTO }

export function DuplicatePreview({ state }: { state: PreviewState }) {
  if (state.status === 'blocked') return null
  return (
    <section aria-label="People already in your CRM" data-testid="duplicate-preview" className="mb-4 space-y-1.5 rounded-md border border-line bg-elevated p-3">
      {state.status === 'checking' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="shrink-0" />
          Checking which rows are people already in your CRM…
        </p>
      )}
      {state.status === 'error' && (
        <p role="status" className="text-sm text-warning">
          Couldn&apos;t check for people already in your CRM ({state.error}). The import still merges them the same way when you commit.
        </p>
      )}
      {state.status === 'done' && (
        <>
          <p role="status" className="text-base font-medium text-fg">
            {duplicateHeadline(state.preview)}
          </p>
          {state.preview.matches.length > 0 && (
            <ul className="space-y-0.5 text-sm">
              {state.preview.matches.map((m) => (
                <li key={m.row}>
                  <a href={`/leads/${m.leadId}`} target="_blank" rel="noreferrer" className="break-words text-link hover:underline">
                    {matchLine(m)}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {moreLine(state.preview) && <p className="text-sm text-muted">{moreLine(state.preview)}</p>}
          {unidentifiedLine(state.preview.unidentified) && (
            <p className="text-sm text-muted">{unidentifiedLine(state.preview.unidentified)}</p>
          )}
        </>
      )}
    </section>
  )
}
