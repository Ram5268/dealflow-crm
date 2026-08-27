import 'dotenv/config'
import { getBoss, stopBoss } from '../src/lib/comms/jobs/boss'
import { QUEUES } from '../src/lib/comms/jobs/queues'
import { handleSendEmailJob } from '../src/lib/comms/jobs/outbound-email'
import { handleGmailDeltaJob } from '../src/lib/comms/jobs/gmail-delta'
import { handleGraphDeltaJob } from '../src/lib/comms/jobs/graph-delta'
import { logger } from '../src/lib/logger'

/**
 * pg-boss worker entrypoint (deploys as a separate Railway service). Registers
 * queue handlers and runs until SIGTERM. `import 'dotenv/config'` is first so
 * DATABASE_URL_MAIN resolves for standalone runs.
 */
async function main() {
  const boss = await getBoss()
  await boss.work(QUEUES.SEND_EMAIL, handleSendEmailJob)
  await boss.work(QUEUES.GMAIL_DELTA_SYNC, handleGmailDeltaJob)
  await boss.work(QUEUES.GRAPH_DELTA_SYNC, handleGraphDeltaJob)
  logger.info('comms worker started; queues: send-email, gmail-delta-sync, graph-delta-sync')
}

async function shutdown() {
  await stopBoss()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
  logger.error({ err }, 'comms worker failed to start')
  process.exit(1)
})
