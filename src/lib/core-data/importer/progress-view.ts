// What the import progress page shows for a status read (GET /api/imports/:id).
// Pure, so it is tested without a browser.
//
// Brief 41.1: the page never offers "Back to the import" while a run may still
// be working: not while importing, not in the minute after a "stopped
// responding" failure (that run may still be finishing a row), and it keeps
// checking after a failure, so a newer run started from another tab hides the
// button again. An import stuck at 'importing' with no progress for 10 minutes
// offers it, since no run is working on it.

export interface ImportStatusView {
  status: string
  progress: number
  totalRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  errorRows: number
  errorLog?: Array<{ row: number; message: string }>
  stalled?: boolean
  retryInSeconds?: number
}

export type ProgressAction = 'none' | 'wait' | 'back' | 'upload' | 'leads'

export interface ProgressView {
  label: string
  percent: number
  // false for an import not started (again): the counts are an old run's.
  showCounts: boolean
  message: string | null
  action: ProgressAction
  // When to check again; null once the import is done.
  pollMs: number | null
}

// The message shown when the uploaded file is no longer stored (also used by
// the mapping page's route, so both say the same thing).
export const FILE_GONE_MESSAGE =
  "The uploaded file is no longer stored (uploads older than a day are cleared), so this import can't run. Please upload the file again."

// Plain words for a failed import (Brief 41: a failed commit stops at 'failed'
// instead of polling forever).
export function failureText(batch: Pick<ImportStatusView, 'errorLog'>): string {
  const reason = batch.errorLog?.find((e) => e.row === 0)?.message.replace(/^Import stopped: /, '') ?? 'unknown error'
  if (/no stored bytes/.test(reason)) return FILE_GONE_MESSAGE
  if (/^time limit reached/.test(reason)) {
    return `The import ran out of time (${reason.replace(/\. Run it again.*$/, '')}). Rows imported so far are kept. Run it again and it continues from there; nothing will be duplicated.`
  }
  if (/stopped responding/.test(reason)) {
    return 'The import stopped responding. Rows imported so far are kept. Run it again and it continues from there.'
  }
  return `The import stopped: ${reason}. Rows imported before it stopped are kept. You can run it again.`
}

const fileGone = (b: ImportStatusView) => /no stored bytes/.test(JSON.stringify(b.errorLog ?? []))

export function progressView(b: ImportStatusView): ProgressView {
  const percent = Math.max(0, Math.min(100, Math.round(b.progress) || 0))
  if (b.status === 'completed') return { label: 'completed', percent, showCounts: true, message: null, action: 'leads', pollMs: null }
  if (b.status === 'failed') {
    const wait = b.retryInSeconds ?? 0
    if (wait > 0) {
      return {
        label: 'failed',
        percent,
        showCounts: true,
        message: `${failureText(b)} The last run is still stopping, so you can run it again in about ${wait} seconds.`,
        action: 'wait',
        pollMs: 3000,
      }
    }
    // Keep checking: if a newer run starts (another tab), the button goes away.
    return { label: 'failed', percent, showCounts: true, message: failureText(b), action: fileGone(b) ? 'upload' : 'back', pollMs: 5000 }
  }
  if (b.status === 'importing' && b.stalled) {
    return {
      label: 'stopped',
      percent,
      showCounts: true,
      message:
        'This import stopped responding: no progress for over 10 minutes. Rows imported so far are kept. Run it again; rows already imported are merged, not duplicated.',
      action: 'back',
      pollMs: 5000,
    }
  }
  // Not started yet, e.g. "Back to the import" reopened it but it wasn't
  // committed again (Brief 41.1 review): say so, and offer the way back, after
  // the minute's wait if the last run stopped responding.
  if (b.status === 'mapping_review' || b.status === 'pending') {
    const wait = b.retryInSeconds ?? 0
    return wait > 0
      ? {
          label: 'not started',
          percent: 0,
          showCounts: false,
          message: `The last run is still stopping. You can commit this import again in about ${wait} seconds.`,
          action: 'wait',
          pollMs: 3000,
        }
      : {
          label: 'not started',
          percent: 0,
          showCounts: false,
          message: "This import hasn't been committed. Go back to the import to check the columns and commit it.",
          action: 'back',
          pollMs: 5000,
        }
  }
  return { label: b.status, percent, showCounts: true, message: null, action: 'none', pollMs: 1500 }
}
