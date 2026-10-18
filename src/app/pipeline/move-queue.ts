// Brief 45 PR D — one person's moves go to the server one at a time.
//
// Two quick moves of the same card ( ] then ] ) are two requests: "out of X,
// into Y", then "out of Y, into Z". Sent at once, the second can reach the
// database before the first has landed (a slow first request, a cold start):
// its "out of Y" removes nothing and the person ends up in Y and Z. Or the
// answers come back in the other order, and the board draws the person in
// two columns while the database has one. So each person's move waits for
// the one before it [engineering precaution]. If a move is refused, the
// moves queued behind it for that person are not sent (they start from a
// column the person never reached), so the card goes back where it was.
// Different people's moves don't wait for each other. Client-safe.
import type { MoveRequest, PendingMove } from './board-state'

export type MoveSettled =
  | { ok: true }
  /** The server refused it, or couldn't be reached: `error` carries the reason. */
  | { ok: false; skipped: false; error: unknown }
  /** Not sent: an earlier move of the same person was refused. */
  | { ok: false; skipped: true }

export type MoveQueue = (move: PendingMove) => Promise<MoveSettled>

export function createMoveQueue(send: (request: MoveRequest) => Promise<void>): MoveQueue {
  const tails = new Map<string, Promise<MoveSettled>>()
  return (move) => {
    const before = tails.get(move.leadId) ?? Promise.resolve<MoveSettled>({ ok: true })
    const settled = before.then(async (prev): Promise<MoveSettled> => {
      if (!prev.ok) return { ok: false, skipped: true }
      try {
        await send({ leadId: move.leadId, fromGroupId: move.fromGroupId, toGroupId: move.toGroupId })
        return { ok: true }
      } catch (error) {
        return { ok: false, skipped: false, error }
      }
    })
    tails.set(move.leadId, settled)
    // Forget a finished chain, so the person's next move starts fresh.
    void settled.then(() => {
      if (tails.get(move.leadId) === settled) tails.delete(move.leadId)
    })
    return settled
  }
}
