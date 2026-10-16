// Brief 41 (H11): tests and maintenance scripts may only touch a test database.
//
// A database whose name ends in `_perf` or `_test` is a test database. Anything
// else (the live CRM is `dealflow_crm`) is refused. Only a maintenance script
// with a real live use (restore-from-backup, brief41-canonical-phones) opts in
// to `--i-mean-live` on its command line, for a deliberate run against this
// database. Tests, smoke scripts and fixture seeds never do (Brief 41.1), and
// their refusal doesn't mention the flag. Pure: no I/O, so it is safe to
// import anywhere.

export const LIVE_OVERRIDE_FLAG = '--i-mean-live'

export function databaseName(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
    // A database name has no "/": "db/x_test" is not a test database.
    return name && !name.includes('/') ? name : null
  } catch {
    return null
  }
}

export function isTestDatabase(url: string | null | undefined): boolean {
  const name = databaseName(url)
  return !!name && /(_perf|_test)$/.test(name)
}

// A script's own arguments, without the override flag, so `--i-mean-live`
// can go anywhere on the command line.
export function scriptArgs(argv: readonly string[] = process.argv): string[] {
  return argv.slice(2).filter((a) => a !== LIVE_OVERRIDE_FLAG)
}

export function assertTestDatabase(
  url: string | null | undefined,
  what: string,
  opts: { argv?: readonly string[]; allowOverride?: boolean } = {},
): void {
  if (isTestDatabase(url)) return
  const allowOverride = opts.allowOverride ?? false
  if (allowOverride && (opts.argv ?? process.argv).includes(LIVE_OVERRIDE_FLAG)) return
  const shown = databaseName(url) ?? (url ? '(unreadable URL)' : '(not set)')
  throw new Error(
    `REFUSING: ${what} would use database "${shown}". ` +
      `Only a *_perf or *_test database is allowed` +
      (allowOverride ? ` (pass ${LIVE_OVERRIDE_FLAG} to run it against this one on purpose).` : '.'),
  )
}
