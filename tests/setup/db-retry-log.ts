// Brief 50 (6.14), engineering precaution: suite 1's setup file. vitest itself
// retries a test whose error is a dropped database connection (the `retry`
// setting in vitest.config.ts, from db-retry.ts); this logs every such retry,
// and the last failed try, so a retried test is never silent.
import { beforeEach } from 'vitest'
import { CONNECTION_ERROR, DB_RETRY_COUNT, firstLine } from './db-retry'

beforeEach(({ onTestFailed }) => {
  onTestFailed(({ task }) => {
    const errors = task.result?.errors ?? []
    const last = errors[errors.length - 1]
    if (!last || !CONNECTION_ERROR.test(last.message ?? '')) return
    const tried = task.result?.retryCount ?? 0
    const allowed = typeof task.retry === 'number' ? task.retry : (task.retry?.count ?? DB_RETRY_COUNT)
    console.warn(
      `[db-retry] "${task.name}": the database connection dropped (${firstLine(last.message)}); ` +
        (tried < allowed ? `retry ${tried + 1} of ${allowed}` : `no retries left after ${tried + 1} tries`),
    )
  })
})
