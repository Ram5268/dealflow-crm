import { describe, it, expect } from 'vitest'
import { progressView, type ImportStatusView } from '@/lib/core-data/importer/progress-view'

// Brief 41.1: what the import progress page shows. It never offers "Back to
// the import" while a run may still be working, keeps checking after a
// failure (a newer run from another tab hides the button again), offers it for
// an import stuck with no progress, and never shows more than 100%.
const base: ImportStatusView = { status: 'importing', progress: 40, totalRows: 10, importedRows: 4, duplicateRows: 0, skippedRows: 0, errorRows: 0, errorLog: [] }
const stop = (message: string, extra: Record<string, unknown> = {}) => ({ errorLog: [{ row: 0, message: `Import stopped: ${message}`, ...extra }] })

describe('progressView', () => {
  it('a working import: progress only, no button, keeps polling', () => {
    expect(progressView(base)).toEqual({ label: 'importing', percent: 40, showCounts: true, message: null, action: 'none', pollMs: 1500 })
  })

  it('a newer run working after a failure: the button goes away', () => {
    const failed = progressView({ ...base, status: 'failed', ...stop('time limit reached after 4 of 10 rows. Run it again to continue') })
    expect(failed).toMatchObject({ action: 'back', pollMs: 5000 })
    expect(failed.message).toMatch(/ran out of time \(time limit reached after 4 of 10 rows\)/)
    // The page kept polling; the next read shows the newer run.
    expect(progressView({ ...base, status: 'importing', importedRows: 0, progress: 0 })).toMatchObject({ action: 'none' })
  })

  it('in the minute after a "stopped responding" failure: no button yet, says when', () => {
    const v = progressView({ ...base, status: 'failed', retryInSeconds: 42, ...stop('the import stopped responding. Run it again to continue', { watchdog: true }) })
    expect(v).toMatchObject({ label: 'failed', action: 'wait', pollMs: 3000 })
    expect(v.message).toMatch(/stopped responding.*run it again in about 42 seconds/)
    expect(progressView({ ...base, status: 'failed', retryInSeconds: 0, ...stop('the import stopped responding') })).toMatchObject({ action: 'back' })
  })

  it('a stuck import with no progress for 10 minutes: offers to run it again', () => {
    const v = progressView({ ...base, stalled: true })
    expect(v).toMatchObject({ label: 'stopped', action: 'back', pollMs: 5000 })
    expect(v.message).toMatch(/no progress for over 10 minutes/)
  })

  it('a file that is gone: upload it again', () => {
    expect(progressView({ ...base, status: 'failed', ...stop('storage: no stored bytes for key "x"') })).toMatchObject({ action: 'upload' })
  })

  it('reopened but not committed again (mapping_review): a plain label and the way back (Brief 41.1 review)', () => {
    const v = progressView({ ...base, status: 'mapping_review' })
    // No percent or counts: they would be the old run's (Brief 41.1 re-review).
    expect(v).toMatchObject({ label: 'not started', percent: 0, showCounts: false, action: 'back', pollMs: 5000 })
    expect(v.message).toMatch(/hasn't been committed/)
    expect(progressView({ ...base, status: 'pending', progress: 0 })).toMatchObject({ label: 'not started', action: 'back' })
  })

  it('reopened within the minute after a "stopped responding" stop: the countdown, then the way back', () => {
    const v = progressView({ ...base, status: 'mapping_review', retryInSeconds: 20, ...stop('the import stopped responding', { watchdog: true }) })
    expect(v).toMatchObject({ label: 'not started', percent: 0, showCounts: false, action: 'wait', pollMs: 3000 })
    expect(v.message).toMatch(/still stopping.*about 20 seconds/)
  })

  it('completed: view leads, stop polling; never more than 100%', () => {
    expect(progressView({ ...base, status: 'completed', progress: 100 })).toMatchObject({ action: 'leads', pollMs: null, percent: 100 })
    expect(progressView({ ...base, progress: 120 }).percent).toBe(100)
    expect(progressView({ ...base, progress: -5 }).percent).toBe(0)
  })
})
