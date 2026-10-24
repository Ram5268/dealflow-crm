import { readCopyRefusal, readNightlyNotice } from '@/lib/core-data/dealflow-sync/nightly-notice'

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

// Brief 50 (PR 19) — on /queue, in both modes (the review list while calling
// is off, the call list while it's on): one line while this morning's copy
// from DealFlow was refused and nothing has been copied since, with how many
// sellers DealFlow's list reached, how many the last copy reached, and the
// date of the order the Queue still shows [Ryan's no-babysitting rule,
// 2026-10-18: checks show up in the product]. Rendered inside its own
// <Suspense fallback={null}>, like the notice above; no refusal, no setting or
// a failed read renders nothing.
export async function MorningCopyNotice({ organizationId }: { organizationId: string }) {
  const text = await readCopyRefusal(organizationId)
  if (!text) return null
  return (
    <div role="status" className="mb-4 rounded-md bg-warning-subtle p-3 text-base font-medium text-warning">
      {text}
    </div>
  )
}
