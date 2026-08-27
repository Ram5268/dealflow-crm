import { PgBoss } from 'pg-boss'
import { logger } from '@/lib/logger'

// Singleton pg-boss instance for background jobs + event-handler retries.
// pg-boss creates and manages its own `pgboss` schema in the main DB. Started
// lazily; the boot-standalone worker calls startBoss() explicitly and registers
// workers. Routes only enqueue.

let boss: PgBoss | null = null
let starting: Promise<PgBoss> | null = null

export const QUEUES = {
  importCommit: 'import.commit',
  event: 'crm.event',
} as const

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss
  if (starting) return starting
  const connectionString = process.env.DATABASE_URL_MAIN
  if (!connectionString) throw new Error('DATABASE_URL_MAIN not set for pg-boss')
  starting = (async () => {
    const instance = new PgBoss({ connectionString, schema: 'pgboss' })
    instance.on('error', (err: Error) => logger.error({ err: err.message }, 'pg-boss error'))
    await instance.start()
    boss = instance
    return instance
  })()
  return starting
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true })
    boss = null
    starting = null
  }
}

export function bossEnabled(): boolean {
  return process.env.USE_PGBOSS === '1'
}
