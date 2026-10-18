import { describe, it, expect } from 'vitest'
import { createMoveQueue } from '@/app/pipeline/move-queue'
import type { MoveRequest, PendingMove } from '@/app/pipeline/board-state'
import type { PipelineCard } from '@/lib/core-data/lists/types'
import { APPT, HOT, NOW, NURTURE, OWNER2_HOT, OWNER3_NURTURE } from './helpers/pipeline-fixtures'

// Brief 45 PR D — one person's moves reach the server one at a time, so two
// quick moves of the same card ( ] ] ) can't land out of order and leave the
// person in two groups. Made-up data; the "server" is a stub we control.

let nextId = 1
const pending = (card: PipelineCard, fromGroupId: string, toGroupId: string): PendingMove =>
  ({ id: nextId++, leadId: card.leadId, fromGroupId, toGroupId, at: NOW, card })

/** A stub server: records each request and answers only when told to. */
function stubServer() {
  const sent: MoveRequest[] = []
  const answers: { ok: () => void; refuse: (e: unknown) => void }[] = []
  const send = (req: MoveRequest) => {
    sent.push(req)
    return new Promise<void>((ok, refuse) => answers.push({ ok: () => ok(), refuse }))
  }
  return { sent, answers, send }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createMoveQueue', () => {
  it('sends exactly the move that was made: out of X, into Y', async () => {
    const s = stubServer()
    const run = createMoveQueue(s.send)
    const done = run(pending(OWNER2_HOT, HOT.id, NURTURE.id))
    await settle()
    expect(s.sent).toEqual([{ leadId: 'lead_2', fromGroupId: HOT.id, toGroupId: NURTURE.id }])
    s.answers[0].ok()
    expect(await done).toEqual({ ok: true })
  })

  it('a second move of the same person waits until the first has landed', async () => {
    const s = stubServer()
    const run = createMoveQueue(s.send)
    const first = run(pending(OWNER2_HOT, HOT.id, APPT.id))
    const second = run(pending(OWNER2_HOT, APPT.id, NURTURE.id))
    await settle()
    expect(s.sent.map((r) => r.toGroupId)).toEqual([APPT.id]) // the second is held back
    s.answers[0].ok()
    expect(await first).toEqual({ ok: true })
    await settle()
    expect(s.sent.map((r) => `${r.fromGroupId}>${r.toGroupId}`)).toEqual([`${HOT.id}>${APPT.id}`, `${APPT.id}>${NURTURE.id}`])
    s.answers[1].ok()
    expect(await second).toEqual({ ok: true })
  })

  it('different people move at the same time', async () => {
    const s = stubServer()
    const run = createMoveQueue(s.send)
    void run(pending(OWNER2_HOT, HOT.id, APPT.id))
    void run(pending(OWNER3_NURTURE, NURTURE.id, HOT.id))
    await settle()
    expect(s.sent.map((r) => r.leadId)).toEqual(['lead_2', 'lead_3'])
  })

  it('a refused move comes back with its reason; the moves queued behind it for that person are not sent', async () => {
    const s = stubServer()
    const run = createMoveQueue(s.send)
    const first = run(pending(OWNER2_HOT, HOT.id, APPT.id))
    const second = run(pending(OWNER2_HOT, APPT.id, NURTURE.id))
    await settle()
    const reason = new Error('Group not found.')
    s.answers[0].refuse(reason)
    expect(await first).toEqual({ ok: false, skipped: false, error: reason })
    expect(await second).toEqual({ ok: false, skipped: true })
    expect(s.sent).toHaveLength(1)
  })

  it("after a refusal, that person's next move is sent as usual", async () => {
    const s = stubServer()
    const run = createMoveQueue(s.send)
    const first = run(pending(OWNER2_HOT, HOT.id, APPT.id))
    await settle()
    s.answers[0].refuse(new Error('x'))
    await first
    await settle()
    const again = run(pending(OWNER2_HOT, HOT.id, NURTURE.id))
    await settle()
    expect(s.sent).toHaveLength(2)
    s.answers[1].ok()
    expect(await again).toEqual({ ok: true })
  })
})
