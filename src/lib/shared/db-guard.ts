// Brief 41 (H11): tests and maintenance scripts may only touch a test database.
//
// A database whose name ends in `_perf` or `_test` is a test database. Anything
// else (the live CRM is `dealflow_crm`) is refused, unless a script is run with
// `--i-mean-live` on its command line. The test suite never accepts the
// override. Pure: no I/O, so it is safe to import anywhere.

export const LIVE_OVERRIDE_FLAG = '--i-mean-live'

export function databaseName(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null
  } catch {
    return null
  }
}

export function isTestDatabase(url: string | null | undefined): boolean {
  const name = databaseName(url)
  return !!name && /(_perf|_test)$/.test(name)
}

export function assertTestDatabase(
  url: string | null | undefined,
  what: string,
  opts: { argv?: readonly string[]; allowOverride?: boolean } = {},
): void {
  if (isTestDatabase(url)) return
  const allowOverride = opts.allowOverride ?? true
  if (allowOverride && (opts.argv ?? process.argv).includes(LIVE_OVERRIDE_FLAG)) return
  throw new Error(
    `REFUSING: ${what} would use database "${databaseName(url) ?? '(not set)'}". ` +
      `Only a *_perf or *_test database is allowed` +
      (allowOverride ? ` (pass ${LIVE_OVERRIDE_FLAG} to run it against this one on purpose).` : '.'),
  )
}
