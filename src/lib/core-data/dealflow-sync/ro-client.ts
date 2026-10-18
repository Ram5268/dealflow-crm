import { Pool } from 'pg'
import { logger } from '@/lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Read-only pg pool into DealFlow's `railway` database. This is a SEPARATE pool
// from Prisma's main pool and from the LISTEN pool — DealFlow is a foreign DB we
// only ever SELECT from. The brief forbids any write to DealFlow; the role
// should have no write grants, and this module issues nothing but SELECTs.
//
// Brief 41.2 (PR F) — engineering precautions from the Oct 16, 2026 system-map
// review (audit M3: the login behind DATABASE_URL_DEALFLOW_RO can write, so
// "read-only" rested on this file alone):
//   • Every statement runs inside BEGIN READ ONLY … ROLLBACK, as DealFlow's
//     lib/crm-sync/roClient.ts does, so Postgres itself refuses a write the
//     first-word check lets through, such as `WITH d AS (DELETE …) SELECT …`.
//   • One statement per call. `SELECT 1; COMMIT; DELETE …` would end the
//     read-only transaction and run the DELETE on its own (with no parameters
//     node-pg uses the simple protocol, which runs every statement it is sent).
//     A `;` before the end (outside quotes and comments) is refused here, and
//     the statement is sent over the extended protocol, where Postgres itself
//     refuses a second command: the backstop to that text check.
//   • This file is the only reader of DATABASE_URL_DEALFLOW_RO
//     (tests/unit/dealflow-ro-setting.test.ts), and it hands out no raw client,
//     so roQuery is the only way the CRM reads DealFlow.
// ─────────────────────────────────────────────────────────────────────────────

let pool: Pool | null = null

function getPool(): Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL_DEALFLOW_RO
  if (!url) throw new Error('DATABASE_URL_DEALFLOW_RO not set')
  pool = new Pool({
    connectionString: url,
    max: 4,
    // Fail fast on a dead RO host so the cron/health don't hang.
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 10_000,
  })
  // Brief 41.2 (PR F), engineering precaution (reliability): when the server or
  // the network drops a connection sitting idle in the pool, pg emits 'error'
  // on the pool, and with no listener that error crashes the function. Log a
  // short line (never the connection string); the pool discards that client
  // and opens a new one on the next query.
  pool.on('error', (err) => {
    logger.warn({ err: err.message }, 'DealFlow read-only pool: an idle connection failed and was dropped')
  })
  return pool
}

// Whether the DealFlow read-only connection is set up (callers outside this
// file ask here instead of reading the setting).
export function dealflowRoConfigured(): boolean {
  return !!process.env.DATABASE_URL_DEALFLOW_RO
}

// The text checks, before anything is sent: a SELECT/WITH first word (kept
// from the original client), and one statement only.
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trimStart().toLowerCase()
  if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
    throw new Error('DealFlow RO client only permits SELECT/WITH statements')
  }
  if (holdsSecondStatement(sql)) {
    throw new Error('DealFlow RO client only permits one statement per query')
  }
}

// True when `sql` holds a `;` with more than whitespace or comments after it.
// A `;` inside a quoted string, a quoted name or a comment doesn't count: the
// sync's own RO_SQL has one in a comment. It follows Postgres's quoting for the
// forms our queries use (with Postgres's default standard_conforming_strings =
// on): '…' with '' inside, E'…' where a backslash escapes too, "…",
// $tag$…$tag$, -- to the end of the line (\n or \r) and /* … */, which nests.
// What it can't be sure of fails closed (counts as true): an unclosed quote or
// comment, and an E'…' string carried on into a '…' on a later line (Postgres
// keeps reading backslashes there; no query of ours needs one). It is not a
// full SQL parser, so the extended protocol in roQuery is the backstop: there
// Postgres refuses a second command whatever this check let through.
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y

function holdsSecondStatement(sql: string): boolean {
  const identChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$\u0080-\uffff]/.test(ch)
  let ended = false // a `;` has been seen
  let afterEString = false // the last token was an E'…' string
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1
    } else if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (depth > 0) {
        if (i >= sql.length) return true
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
    } else if (/\s/.test(ch)) {
      i += 1
    } else if (ended) {
      return true // something after the `;`: a second statement
    } else if (ch === "'" && afterEString) {
      return true // E'…' carried on into a '…' (see above)
    } else if (ch === ';') {
      ended = true
      afterEString = false
      i += 1
    } else if (ch === "'" || ch === '"') {
      const backslashEscapes = ch === "'" && /[Ee]/.test(sql[i - 1] ?? '') && !identChar(sql[i - 2])
      i += 1
      for (;;) {
        if (i >= sql.length) return true
        if (backslashEscapes && sql[i] === '\\') i += 2
        else if (sql[i] === ch && sql[i + 1] === ch) i += 2
        else if (sql[i] === ch) break
        else i += 1
      }
      i += 1
      afterEString = backslashEscapes
    } else if (ch === '$' && !identChar(sql[i - 1])) {
      afterEString = false
      DOLLAR_TAG.lastIndex = i
      const tag = DOLLAR_TAG.exec(sql)?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        if (close === -1) return true
        i = close + tag.length
      } else {
        i += 1 // a parameter such as $1
      }
    } else {
      afterEString = false
      i += 1
    }
  }
  return false
}

// Convenience: run a read-only query and release the client. Guards against
// accidental writes three ways: the text checks above, a READ ONLY
// transaction Postgres enforces, and the extended protocol (one command).
export async function roQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  assertReadOnlySql(sql)
  const client = await getPool().connect()
  let broken = false
  try {
    await client.query('BEGIN READ ONLY')
    // A variable, not an inline literal: @types/pg doesn't list queryMode.
    const statement = { text: sql, values: params, queryMode: 'extended' }
    const res = await client.query(statement)
    return res.rows as T[]
  } finally {
    // Always ROLLBACK, so nothing a statement did inside the transaction
    // outlives it. A client whose ROLLBACK fails is destroyed rather than put
    // back in the pool in an unknown state.
    await client.query('ROLLBACK').catch(() => {
      broken = true
    })
    client.release(broken)
  }
}

export async function closeDealflowRoPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
