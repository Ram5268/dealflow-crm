// Brief 50 (6.14), engineering precaution: the shared Railway perf database
// drops connections at times ("Can't reach database server", connection-pool
// timeouts), and a whole gate run then failed although a re-run passed. So:
//   - suite 1 (vitest.config.ts) retries a failed test only when its error is
//     a dropped connection, at most DB_RETRY_COUNT times, and
//     db-retry-log.ts logs every retry;
//   - setup steps outside a test body (the schema push, the 25k seed) use
//     withConnectionRetry, with the same rule.
// An assertion failure, a constraint error, a timeout or anything else is never
// retried. Pure: no I/O, so vitest.config.ts can import it.

export const DB_RETRY_COUNT = 2
export const DB_RETRY_DELAY_MS = 2_000
export const DB_RETRY_LOG_FILE = 'tests/setup/db-retry-log.ts'

// Messages of connection-level failures: Prisma's engine (P1001, P1002, P1017,
// P2024, a closed socket), node-postgres, Postgres itself (57P01 when the
// server restarts), and the socket errors underneath.
const CONNECTION_MESSAGES = [
  "Can't reach database server",
  'was reached but timed out',
  'Server has closed the connection',
  'Timed out fetching a new connection from the connection pool',
  'Error in PostgreSQL connection',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'terminating connection due to administrator command',
  'the database system is starting up',
  'the database system is shutting down',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]
const CONNECTION_CODES = new Set([
  'P1001', 'P1002', 'P1017', 'P2024', // Prisma
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', // sockets
  '08000', '08001', '08003', '08004', '08006', '57P01', '57P02', '57P03', // Postgres connection classes
])

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Tested against a failed test's error message (vitest's retry condition in a
// config file must be a RegExp). The lookahead skips assertion messages, which
// start with "expected": an assertion that merely mentions one of these words
// is never retried.
export const CONNECTION_ERROR = new RegExp(
  `^(?!expected\\b)[\\s\\S]*?(?:${CONNECTION_MESSAGES.map(escapeRegExp).join('|')})`,
)

export const DB_TEST_RETRY = { count: DB_RETRY_COUNT, delay: DB_RETRY_DELAY_MS, condition: CONNECTION_ERROR }

export function isConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; code?: unknown; errorCode?: unknown; message?: unknown }
  if (e.name === 'AssertionError') return false
  for (const code of [e.code, e.errorCode]) if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true
  return typeof e.message === 'string' && CONNECTION_ERROR.test(e.message)
}

// Engineering precaution: retry logs and setup errors never carry a database
// address (Prisma's messages name the host; a URL may hold the password).
export function redactDatabaseHosts(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/g, 'postgresql://<redacted>')
    .replace(/\bat ([`"'])[^`"'\s]+\1/g, 'at <db host>')
}

export function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return redactDatabaseHosts(message.split('\n').map((l) => l.trim()).find(Boolean) ?? message)
}

export async function withConnectionRetry<T>(
  what: string,
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; log?: (line: string) => void } = {},
): Promise<T> {
  const retries = opts.retries ?? DB_RETRY_COUNT
  const delayMs = opts.delayMs ?? DB_RETRY_DELAY_MS
  const log = opts.log ?? ((line: string) => console.warn(line))
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries || !isConnectionError(err)) throw err
      log(
        `[db-retry] ${what}: the database connection dropped (${firstLine(err)}); ` +
          `retry ${attempt + 1} of ${retries} in ${delayMs / 1000} s`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
