import { readNightlyNotice } from '@/lib/core-data/dealflow-sync/nightly-notice'

// Brief 47 (PR 6) — on /queue, in both calling-on and review modes: a notice
// when DealFlow's newest nightly, within the last 2 days, was stopped by a
// safety check (Brief 47 PR 1) or ran without our values (Brief 44's automatic
// switch-off) [engineering precaution, the planner, Brief 47, 2026-10-18].
// The page renders it inside <Suspense fallback={null}>, so the Queue never
// waits on DealFlow; no notice, no setting or a failed read renders nothing.
export async function NightlyNoticeBanner() {
  const text = await readNightlyNotice()
  if (!text) return null
  return (
    <div role="status" className="mb-4 rounded-md bg-warning-subtle p-3 text-base font-medium text-warning">
      {text}
    </div>
  )
}
