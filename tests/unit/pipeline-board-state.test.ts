import { describe, it, expect } from 'vitest'
import {
  appendColumnPage, applyMove, boardWithPending, neighborGroup, type BoardContext, type PendingMove,
} from '@/app/pipeline/board-state'
import type { PipelineBoard, PipelineCard } from '@/lib/core-data/lists/types'
import {
  APPT, GROUPS, HOT, NOW, NURTURE, OWNER1_HOT, OWNER2_HOT, card, daysBefore, makeBoard,
} from './helpers/pipeline-fixtures'

// Brief 45 PR D — moving a card on the Pipeline board [brief §5.6]: drag (or
// keys) from column X to column Y = out of group X, into group Y. The board
// shows the move at once (optimistic) and takes it back if the server says no
// (rollback). These are the pure functions behind that.

const ctx: BoardContext = { groups: GROUPS, filters: {} }
let nextId = 1
function move(leadId: string, fromGroupId: string, toGroupId: string, board = makeBoard()): PendingMove {
  const from = board.columns.find((c) => c.group.id === fromGroupId)!
  return { id: nextId++, leadId, fromGroupId, toGroupId, at: NOW, card: from.cards.find((c) => c.leadId === leadId)! }
}
const column = (b: PipelineBoard, groupId: string) => b.columns.find((c) => c.group.id === groupId)!
const ids = (b: PipelineBoard, groupId: string) => column(b, groupId).cards.map((c) => c.leadId)
const counts = (b: PipelineBoard) => b.columns.map((c) => c.count)

describe('applyMove (one card from column X to column Y)', () => {
  it('leaves X, joins Y at its rank position, counts follow, and it is "in Y since" now', () => {
    const b = applyMove(makeBoard(), move('lead_2', HOT.id, NURTURE.id), ctx)
    expect(ids(b, HOT.id)).toEqual(['lead_1'])
    expect(ids(b, NURTURE.id)).toEqual(['lead_1', 'lead_2', 'lead_3']) // ranks 2, 3, 5
    expect(counts(b)).toEqual([1, 3, 1])
    const moved = column(b, NURTURE.id).cards[1]
    expect(moved).toMatchObject({ leadId: 'lead_2', inGroupSince: NOW, alsoIn: [] })
    expect(moved.groups.map((g) => g.name)).toEqual(['Nurture'])
  })

  it('updates the chips and "also in" marks on every card of that person', () => {
    // Owner 1 is in Hot and Nurture; moving the Hot card to Appointment Set.
    const b = applyMove(makeBoard(), move('lead_1', HOT.id, APPT.id), ctx)
    expect(ids(b, HOT.id)).toEqual(['lead_2'])
    expect(ids(b, APPT.id)).toEqual(['lead_1', 'lead_4'])
    const inNurture = column(b, NURTURE.id).cards.find((c) => c.leadId === 'lead_1')!
    const inAppt = column(b, APPT.id).cards.find((c) => c.leadId === 'lead_1')!
    expect(inNurture.groups.map((g) => g.name)).toEqual(['Nurture', 'Appointment Set']) // sidebar order
    expect(inNurture.alsoIn).toEqual([{ id: APPT.id, name: 'Appointment Set' }])
    expect(inAppt.alsoIn).toEqual([{ id: NURTURE.id, name: 'Nurture' }])
    expect(inAppt.inGroupSince).toBe(NOW)
    expect(inNurture.inGroupSince).toBe(daysBefore(10)) // untouched: still in Nurture since then
    expect(inAppt).toMatchObject({ displayName: OWNER1_HOT.displayName, bestBuyer: OWNER1_HOT.bestBuyer, rank: 2 })
  })

  it('a person already in Y just leaves X (one lead, never two cards in one column)', () => {
    const b = applyMove(makeBoard(), move('lead_1', HOT.id, NURTURE.id), ctx)
    expect(ids(b, HOT.id)).toEqual(['lead_2'])
    expect(ids(b, NURTURE.id)).toEqual(['lead_1', 'lead_3'])
    expect(counts(b)).toEqual([1, 2, 1])
    expect(column(b, NURTURE.id).cards[0]).toMatchObject({ alsoIn: [], groups: [{ id: NURTURE.id, name: 'Nurture', color: 'green' }] })
  })

  it('to a group that is not shown as a column: leaves X; the other cards learn the new group', () => {
    const board = makeBoard()
    board.columns = board.columns.filter((c) => c.group.id !== APPT.id)
    const b = applyMove(board, move('lead_1', HOT.id, APPT.id, board), ctx)
    expect(b.columns.map((c) => c.group.id)).toEqual([HOT.id, NURTURE.id])
    expect(ids(b, HOT.id)).toEqual(['lead_2'])
    expect(column(b, NURTURE.id).cards[0].alsoIn).toEqual([{ id: APPT.id, name: 'Appointment Set' }])
  })

  it('beyond the loaded cards of a longer column: counted, shown when that page loads', () => {
    const board = makeBoard()
    const nurture = column(board, NURTURE.id)
    nurture.cards = [card({ leadId: 'lead_9', rank: 1, groups: [{ id: NURTURE.id, name: 'Nurture', color: 'green' }] })]
    nurture.count = 60
    nurture.hasMore = true
    const b = applyMove(board, move('lead_2', HOT.id, NURTURE.id, board), ctx)
    expect(ids(b, NURTURE.id)).toEqual(['lead_9'])
    expect(column(b, NURTURE.id)).toMatchObject({ count: 61, hasMore: true })
  })

  it('with "time in group" filtered, a just-moved person does not show in Y (0 days there)', () => {
    const b = applyMove(makeBoard(), move('lead_2', HOT.id, NURTURE.id), { ...ctx, filters: { timeInGroup: '30' } })
    expect(ids(b, NURTURE.id)).toEqual(['lead_1', 'lead_3'])
    expect(counts(b)).toEqual([1, 2, 1])
  })

  it('with "in more than one group" filtered, a person left in one group disappears from the board', () => {
    const board = makeBoard()
    const b = applyMove(board, move('lead_1', HOT.id, NURTURE.id, board), { ...ctx, filters: { multiGroup: '1' } })
    expect(b.columns.flatMap((c) => c.cards.map((x) => x.leadId))).not.toContain('lead_1')
    expect(counts(b)).toEqual([1, 1, 1])
  })

  it('is safe to apply twice (a refresh that already shows the move changes nothing)', () => {
    const m = move('lead_2', HOT.id, NURTURE.id)
    const once = applyMove(makeBoard(), m, ctx)
    expect(applyMove(once, m, ctx)).toEqual(once)
  })

  it('never changes the board it was given', () => {
    const board = makeBoard()
    applyMove(board, move('lead_1', HOT.id, APPT.id, board), ctx)
    expect(board).toEqual(makeBoard())
  })
})

describe('optimistic moves and rollback', () => {
  it('shows a move at once; if the server refuses, the board is exactly as before', () => {
    const base = makeBoard()
    const m = move('lead_2', HOT.id, APPT.id)
    expect(ids(boardWithPending(base, [m], ctx), APPT.id)).toEqual(['lead_2', 'lead_4'])
    // Refused: the move is dropped from the pending list → the original board.
    expect(boardWithPending(base, [], ctx)).toEqual(makeBoard())
  })

  it('two moves at once, one refused: only that one is taken back', () => {
    const base = makeBoard()
    const ok = move('lead_2', HOT.id, APPT.id)
    const refused = move('lead_3', NURTURE.id, HOT.id)
    const both = boardWithPending(base, [ok, refused], ctx)
    expect(ids(both, HOT.id)).toEqual(['lead_1', 'lead_3'])
    const after = boardWithPending(applyMove(base, ok, ctx), [], ctx) // ok committed, refused dropped
    expect(ids(after, HOT.id)).toEqual(['lead_1'])
    expect(ids(after, NURTURE.id)).toEqual(['lead_1', 'lead_3'])
    expect(ids(after, APPT.id)).toEqual(['lead_2', 'lead_4'])
  })
})

describe('load more and keyboard neighbours', () => {
  it('appends the next page of one column, skipping anyone already shown', () => {
    const board = makeBoard()
    const hot = column(board, HOT.id)
    hot.count = 3
    hot.hasMore = true
    const extra: PipelineCard = card({ leadId: 'lead_7', rank: 9, displayName: 'Test Owner 7' })
    const b = appendColumnPage(board, { group: HOT, count: 3, cards: [OWNER2_HOT, extra], hasMore: false, page: 2 })
    expect(ids(b, HOT.id)).toEqual(['lead_1', 'lead_2', 'lead_7'])
    expect(column(b, HOT.id)).toMatchObject({ count: 3, hasMore: false, page: 2 })
    expect(ids(b, NURTURE.id)).toEqual(['lead_1', 'lead_3'])
  })

  it('[ and ] reach the column to the left / right, and stop at the ends', () => {
    const b = makeBoard()
    expect(neighborGroup(b, HOT.id, 1)).toBe(NURTURE.id)
    expect(neighborGroup(b, NURTURE.id, -1)).toBe(HOT.id)
    expect(neighborGroup(b, HOT.id, -1)).toBeNull()
    expect(neighborGroup(b, APPT.id, 1)).toBeNull()
  })
})
