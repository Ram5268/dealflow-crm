import { prisma } from '../prisma'
import { MessageReceivedEvent } from '../../../contracts/events/message.received'

/**
 * Event emission for the Communications slice (brief §8).
 *
 * The ONLY event D emits: `message.received` on channel `crm_message`, one per
 * inbound email/SMS. Payload is validated against the FROZEN Zod schema on every
 * emit (Gate-2) — no `eventName`, no `type` discriminant; channel name is the
 * routing signal. The SSE bridge + Agent A's activity projector consume it.
 *
 * Postgres caps NOTIFY payloads at 8000 bytes; this payload is tiny. Do not add
 * fields without routing a contract change (§14).
 *
 * `client` is injectable (a Prisma tx client or the singleton) so the NOTIFY can
 * ride in the same transaction as the row insert when needed, and so this is
 * unit-testable without a database.
 */

export const CRM_MESSAGE_CHANNEL = 'crm_message'

export interface RawExecutor {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

export async function notifyMessageReceived(
  payload: MessageReceivedEvent,
  client: RawExecutor = prisma as unknown as RawExecutor,
): Promise<void> {
  // Throws if the payload drifts from the frozen contract — fail loud at the emit
  // site rather than shipping a malformed event the projector can't parse.
  const validated = MessageReceivedEvent.parse(payload)
  const json = JSON.stringify(validated)
  await client.$executeRaw`SELECT pg_notify(${CRM_MESSAGE_CHANNEL}, ${json})`
}
