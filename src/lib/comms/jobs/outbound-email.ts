import { sendEmailMessage } from '../email/send'
import { logger } from '../../logger'

/**
 * pg-boss worker for the `send-email` queue. Sends the referenced outbox Message
 * (immediate sends go inline from the route; sequence sends land here). On error
 * it rethrows so pg-boss retries with backoff; the Message keeps its pre-set
 * providerMessageId, so a retry can't produce a duplicate. Accepts pg-boss's
 * single-job or batched-array handler shapes.
 */
export interface SendEmailJob {
  messageId: string
}

type Job = { data: SendEmailJob }

export async function handleSendEmailJob(input: Job | Job[]): Promise<void> {
  const jobs = Array.isArray(input) ? input : [input]
  for (const job of jobs) {
    const { messageId } = job.data
    try {
      await sendEmailMessage(messageId)
    } catch (err) {
      logger.error({ err, messageId }, 'send-email job failed; will retry')
      throw err
    }
  }
}
