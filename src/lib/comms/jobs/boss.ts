import { PgBoss } from 'pg-boss'
import { logger } from '../../logger'
import { ALL_QUEUES } from './queues'

/**
 * pg-boss singleton (brief §pg-boss). Backed by `DATABASE_URL_MAIN`, schema
 * `pgboss` (created on first boot). Retries + persistence live in Postgres, so
 * jobs survive restarts. The worker entrypoint (`scripts/comms-worker.ts`) calls
 * `getBoss()` then registers handlers; API routes call `getBoss()` to enqueue.
 */
let instance: PgBoss | null = null
let starting: Promise<PgBoss> | null = null

export async function getBoss(): Promise<PgBoss> {
  if (instance) return instance
  if (starting) return starting

  starting = (async () => {
    const connectionString = process.env.DATABASE_URL_MAIN
    if (!connectionString) {
      throw new Error('DATABASE_URL_MAIN is not set — cannot start pg-boss.')
    }
    const boss = new PgBoss({
      connectionString,
      schema: process.env.PG_BOSS_SCHEMA ?? 'pgboss',
    })
    boss.on('error', (err: Error) => logger.error({ err }, 'pg-boss error'))
    await boss.start()
    // pg-boss v12 requires queues to exist before send/work.
    await Promise.all(ALL_QUEUES.map((q) => boss.createQueue(q)))
    instance = boss
    return boss
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

export async function stopBoss(): Promise<void> {
  if (instance) {
    await instance.stop()
    instance = null
  }
}
