// Brief 45 PR D — moving cards on the Pipeline board, as pure functions.
//
// A drag (or [ / ] / "Move to group…") from column X to column Y takes the
// person out of group X and puts them in group Y [brief §5.6]; the server
// does it in one step (POST /api/core-data/groups/move, two timeline
// entries). The board shows the move at once: the page keeps the server's
// board plus the moves still in flight, and draws
//   boardWithPending(serverBoard, pendingMoves)
// A refused move is simply dropped from the pending list, so the board is
// exactly as it was (rollback); a confirmed one is applied to the server
// board. One person is one lead [Ryan, 2026-10-18]: a lead never has two
// cards in one column, and every card of that lead learns its new groups.
import type {
  GroupChipDTO, GroupColor, PipelineBoard, PipelineCard, PipelineColumn, PipelineFilters,
} from '@/lib/core-data/lists/types'

export interface MoveRequest {
  leadId: string
  fromGroupId: string
  toGroupId: string
}

export interface PendingMove extends MoveRequest {
  /** Tells concurrent moves apart. */
  id: number
  /** When it was made (ISO): the card's "in group since" in its new column. */
  at: string
  /** The card as it was in column X (to draw it in column Y). */
  card: PipelineCard
}

export interface BoardContext {
  /** Every group, in sidebar order: a card's chips follow it. */
  groups: readonly { id: string; name: string; color: GroupColor }[]
  /** The filters on screen (two of them depend on group membership). */
  filters: PipelineFilters
}

// The lead's groups as the board last knew them.
function knownGroups(board: PipelineBoard, move: PendingMove): GroupChipDTO[] {
  for (const col of board.columns) {
    const c = col.cards.find((x) => x.leadId === move.leadId)
    if (c) return c.groups
  }
  return move.card.groups
}

function inSidebarOrder(chips: GroupChipDTO[], ctx: BoardContext): GroupChipDTO[] {
  const order = new Map(ctx.groups.map((g, i) => [g.id, i]))
  const at = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...chips].sort((a, b) => at(a.id) - at(b.id))
}

const sameChips = (a: GroupChipDTO[], b: GroupChipDTO[]) =>
  a.length === b.length && a.every((g, i) => g.id === b[i].id && g.name === b[i].name && g.color === b[i].color)
const sameAlsoIn = (a: PipelineCard['alsoIn'], b: PipelineCard['alsoIn']) =>
  a.length === b.length && a.every((g, i) => g.id === b[i].id && g.name === b[i].name)

const withoutCard = (col: PipelineColumn, i: number): PipelineColumn => ({
  ...col, count: Math.max(0, col.count - 1), cards: col.cards.filter((_, j) => j !== i),
})

/** The board after one move. Never changes its input; safe to apply twice. */
export function applyMove(board: PipelineBoard, move: PendingMove, ctx: BoardContext): PipelineBoard {
  if (move.fromGroupId === move.toGroupId) return board
  const before = knownGroups(board, move)
  const wasInTarget = before.some((g) => g.id === move.toGroupId)
  const target = ctx.groups.find((g) => g.id === move.toGroupId) ?? board.columns.find((c) => c.group.id === move.toGroupId)?.group
  let after = before.filter((g) => g.id !== move.fromGroupId)
  if (!wasInTarget && target) after = inSidebarOrder([...after, { id: target.id, name: target.name, color: target.color }], ctx)
  // "In more than one group": someone left in one group no longer matches.
  const stillMatches = !(ctx.filters.multiGroup && after.length < 2)
  const relabel = (c: PipelineCard, groupId: string): PipelineCard => ({
    ...c,
    groups: after,
    alsoIn: after.filter((g) => g.id !== groupId).map((g) => ({ id: g.id, name: g.name })),
  })

  const columns = board.columns.map((col): PipelineColumn => {
    const groupId = col.group.id
    const i = col.cards.findIndex((c) => c.leadId === move.leadId)
    if (groupId === move.fromGroupId) return i < 0 ? col : withoutCard(col, i)
    if (i >= 0) {
      if (!stillMatches) return withoutCard(col, i)
      const old = col.cards[i]
      const next = relabel(old, groupId)
      if (sameChips(old.groups, next.groups) && sameAlsoIn(old.alsoIn, next.alsoIn)) return col
      return { ...col, cards: col.cards.map((c, j) => (j === i ? next : c)) }
    }
    if (groupId !== move.toGroupId) return col
    // Already in Y, on a page not loaded yet: nothing to draw.
    if (wasInTarget) return stillMatches ? col : { ...col, count: Math.max(0, col.count - 1) }
    // Just added to Y: 0 days there, so "time in group" never matches yet.
    if (!stillMatches || ctx.filters.timeInGroup) return col
    const card = relabel({ ...move.card, inGroupSince: move.at }, groupId)
    // Cards are in All-leads rank order, so the new one's place is known; past
    // the loaded cards of a longer column it shows when that page loads.
    const pos = col.cards.findIndex((c) => c.rank > card.rank)
    const at = pos < 0 ? col.cards.length : pos
    if (at === col.cards.length && col.hasMore) return { ...col, count: col.count + 1 }
    return { ...col, count: col.count + 1, cards: [...col.cards.slice(0, at), card, ...col.cards.slice(at)] }
  })
  return { ...board, columns }
}

/** What the page draws: the server's board with every move still in flight. */
export function boardWithPending(base: PipelineBoard, pending: readonly PendingMove[], ctx: BoardContext): PipelineBoard {
  return pending.reduce((b, m) => applyMove(b, m, ctx), base)
}

/** "Load more": the next page of one column, skipping anyone already shown. */
export function appendColumnPage(board: PipelineBoard, next: PipelineColumn): PipelineBoard {
  return {
    ...board,
    columns: board.columns.map((col) => {
      if (col.group.id !== next.group.id) return col
      const shown = new Set(col.cards.map((c) => c.leadId))
      return { ...col, count: next.count, hasMore: next.hasMore, page: next.page, cards: [...col.cards, ...next.cards.filter((c) => !shown.has(c.leadId))] }
    }),
  }
}

/** Replace one column with a fresh copy from the server (after a move into or out of a longer column). */
export function replaceColumn(board: PipelineBoard, fresh: PipelineColumn): PipelineBoard {
  return { ...board, columns: board.columns.map((col) => (col.group.id === fresh.group.id ? fresh : col)) }
}

/** The column to the left (-1) or right (+1) of a group's, or null at the edge. */
export function neighborGroup(board: PipelineBoard, groupId: string, dir: -1 | 1): string | null {
  const i = board.columns.findIndex((c) => c.group.id === groupId)
  if (i < 0) return null
  return board.columns[i + dir]?.group.id ?? null
}
