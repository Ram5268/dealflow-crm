// Brief 45 PR D — one person's group changes go to the server one at a time.
//
// Two quick moves of the same card ( ] then ] ) are two requests: "out of X,
// into Y", then "out of Y, into Z". Sent at once, the second can reach the
// database before the first has landed (a slow first request, a cold start):
// its "out of Y" removes nothing and the person ends up in Y and Z. Or the
// answers come back in the other order, and the board draws the person in
// two columns while the database has one. The same goes for a move and a
// group chip on that person's card (] then 1, or a drag then a chip click):
// the chip's "add to X" can land before the move's "out of X" and be undone.
// So every change to one person's groups on the Pipeline — moves and chips —
// waits for the one before it [engineering precaution]. If a move is
// refused, the moves queued behind it for that person are not sent (they
// start from a column the person never reached), so the card goes back where
// it was; a chip change still goes (it doesn't depend on a column). Different
// people don't wait for each other. Client-safe.
import type { MoveRequest, PendingMove } from './board-state'

/** One line per person: each change for that person starts after the one before it has finished. */
export interface PersonQueue {
  run<T>(leadId: string, task: () => Promise<T>): Promise<T>
}

export function createPersonQueue(): PersonQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    run(leadId, task) {
      const before = tails.get(leadId) ?? Promise.resolve()
      const result = before.then(task)
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(leadId, tail)
      // Forget a finished line, so the person's next change starts fresh.
      void tail.then(() => {
        if (tails.get(leadId) === tail) tails.delete(leadId)
      })
      return result
    },
  }
}

export type MoveSettled =
  | { ok: true }
  /** The server refused it, or couldn't be reached: `error` carries the reason. */
  | { ok: false; skipped: false; error: unknown }
  /** Not sent: an earlier move of the same person was refused. */
  | { ok: false; skipped: true }

export type MoveQueue = (move: PendingMove) => Promise<MoveSettled>

export function createMoveQueue(send: (request: MoveRequest) => Promise<void>, people: PersonQueue = createPersonQueue()): MoveQueue {
  // Per person, while moves are queued: has one of them been refused?
  const bursts = new Map<string, { queued: number; refused: boolean }>()
  return (move) => {
    const burst = bursts.get(move.leadId) ?? { queued: 0, refused: false }
    burst.queued++
    bursts.set(move.leadId, burst)
    return people
      .run(move.leadId, async (): Promise<MoveSettled> => {
        if (burst.refused) return { ok: false, skipped: true }
        try {
          await send({ leadId: move.leadId, fromGroupId: move.fromGroupId, toGroupId: move.toGroupId })
          return { ok: true }
        } catch (error) {
          burst.refused = true
          return { ok: false, skipped: false, error }
        }
      })
      .finally(() => {
        if (--burst.queued === 0 && bursts.get(move.leadId) === burst) bursts.delete(move.leadId)
      })
  }
}
