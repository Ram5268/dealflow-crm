import type { Prisma } from "@prisma/client";

/**
 * Emit an event on the Postgres `crm_call` LISTEN/NOTIFY channel.
 *
 * MUST be called inside the SAME transaction that writes the state change:
 * `pg_notify` fires at COMMIT, so the emission is atomic with the state row (a
 * rolled-back tx emits nothing). Never emit outside a tx.
 *
 * Payload carries a `type` discriminant and NO `eventName` field (planner lock
 * §8.3 item 1). `cost` on call.completed is a decimal-as-string (item 2).
 */
export async function emitOnCallChannel(
  tx: Prisma.TransactionClient,
  payload: object,
): Promise<void> {
  const json = JSON.stringify(payload);
  await tx.$executeRawUnsafe(`SELECT pg_notify('crm_call', $1)`, json);
}
