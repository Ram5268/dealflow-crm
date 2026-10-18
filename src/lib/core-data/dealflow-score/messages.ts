// Brief 45 (PR F): the plain-English reasons an upload's new people could not
// be ranked right away, and the sentence the import page shows for them
// [brief §5.8: "If DealFlow is unreachable, the import still completes. The
// new people show 'scoring…', the import page says so, and the morning sync
// catches up"]. Stored in ImportBatch.dealflowScoreError. Browser-safe: no
// imports.

export const SCORE_ERROR = {
  unreachable: "Couldn't reach DealFlow just now",
  timeout: 'DealFlow took too long to answer',
  server: 'DealFlow ran into a problem just now',
  unreadable: "DealFlow's answer couldn't be read",
  refused: 'DealFlow turned the request down',
  expired: 'More than an hour has passed since this upload finished',
  save: "The new rankings couldn't be saved just now",
  // No DEALFLOW_APP_BASE_URL, and not Vercel's production deployment (request.ts).
  noAddress: "DealFlow isn't connected on this server",
} as const

export type ScoreError = (typeof SCORE_ERROR)[keyof typeof SCORE_ERROR]

export const count = (n: number) => n.toLocaleString('en-US')

/** "the 380 new people" / "the new person" */
export function theNewPeople(n: number): string {
  return n === 1 ? 'the new person' : `the ${count(n)} new people`
}

/**
 * The fallback: "Couldn't reach DealFlow just now, so the 380 new people will
 * be ranked in tomorrow morning's update. They show “scoring…” until then."
 * (the brief's wording, §5.8 / the PR F task).
 */
export function fallbackText(reason: string, newPeople: number): string {
  return `${reason}, so ${theNewPeople(newPeople)} will be ranked in tomorrow morning's update. They show “scoring…” until then.`
}
