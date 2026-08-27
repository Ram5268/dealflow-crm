import { Pool } from 'pg'
import type { PoolClient } from 'pg'

// ─────────────────────────────────────────────────────────────────────────────
// Read-only pg pool into DealFlow's `railway` database. This is a SEPARATE pool
// from Prisma's main pool and from the LISTEN pool — DealFlow is a foreign DB we
// only ever SELECT from. The brief forbids any write to DealFlow; the role
// should have no write grants, and this module issues nothing but SELECTs.
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
  return pool
}

export async function getDealflowRoClient(): Promise<PoolClient> {
  return getPool().connect()
}

// Convenience: run a read-only query and release the client. Guards against
// accidental writes by rejecting non-SELECT/WITH statements.
export async function roQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const trimmed = sql.trimStart().toLowerCase()
  if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
    throw new Error('DealFlow RO client only permits SELECT/WITH statements')
  }
  const client = await getDealflowRoClient()
  try {
    const res = await client.query(sql, params)
    return res.rows as T[]
  } finally {
    client.release()
  }
}

export async function closeDealflowRoPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
