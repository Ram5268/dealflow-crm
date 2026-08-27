import { Prisma } from "@prisma/client";

/**
 * Milestone 1b — Two-legs-answer race resolver.
 *
 * When async AMD flags two legs of the same Call as `human` near-simultaneously,
 * exactly ONE leg may be bridged to the operator; the other must be dropped with
 * a professional message (and counted as an abandoned call). We serialize that
 * decision with a Postgres transaction-scoped advisory lock keyed on the Call.id.
 *
 * `pg_try_advisory_xact_lock` is non-blocking: the first tx to grab the lock
 * gets `true`, all concurrent contenders get `false` immediately (no queueing).
 * The lock auto-releases on tx COMMIT or ROLLBACK — no manual unlock, no leak on
 * crash. This is why the helper MUST run inside a `prisma.$transaction`.
 *
 * `hashtextextended(text, seed)` maps the callId into the 64-bit advisory-lock
 * key space (bigint). Collision-free for any realistic callId cardinality.
 */
export async function tryAcquireCallWinner(
  tx: Prisma.TransactionClient,
  callId: string,
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<{ won: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) as won`,
    callId,
  );
  return rows[0].won;
}
