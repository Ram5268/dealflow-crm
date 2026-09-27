import { sendEmailMessage } from '../email/send'
import { EmailDisabledError } from '../email/config'
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
      // Brief 37: email is off. Drop the job rather than retry it, so nothing
      // queued during the test phase can go out once the switch flips.
      if (err instanceof EmailDisabledError) {
        logger.warn({ messageId }, 'send-email job dropped: email is off (EMAIL_ENABLED)')
        continue
      }
      logger.error({ err, messageId }, 'send-email job failed; will retry')
      throw err
    }
  }
}
