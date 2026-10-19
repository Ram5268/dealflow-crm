'use client'

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CalendarClock, Clock, Ellipsis, Layers, Star, UsersRound } from 'lucide-react'
import {
  Badge, Button, DropdownContent, DropdownItem, DropdownLabel, DropdownRoot, DropdownSeparator, DropdownTrigger, IconButton,
} from '@/components/ui'
import type { GroupDTO, PipelineBoard as Board, PipelineCard } from '@/lib/core-data/lists/types'
import { isEditableTarget } from '@/lib/ui/hotkeys'
import { cn } from '@/lib/ui/cn'
import { groupColorStyle } from '@/lib/ui/groupColors'
import { neighborGroup } from './board-state'
import { cardKeyAction } from './keys'
import { dueText, inGroupText, lastContactText, type DueTone } from './format'
import { PipelineGroupChips } from './PipelineGroupChips'

const keyOf = (groupId: string, leadId: string) => `${groupId}:${leadId}`
// Our own drag type: a card dropped on a text field elsewhere pastes nothing.
const DRAG_TYPE = 'application/x-dealflow-pipeline-card'
const TONE: Record<DueTone, string> = { danger: 'text-danger', warning: 'text-warning', muted: 'text-muted' }

/**
 * The Pipeline board [brief §5.6]: one column per group in sidebar order,
 * each with its count; cards in All-leads rank order, 50 at a time.
 *
 * Moving a card: drag it to another column, or — for every drag, a key
 * [brief §7] — focus it and press [ / ] (the column to the left / right) or
 * M ("Move to group…", any group). On a phone, where dragging doesn't work,
 * the card's "⋯" menu does the same. Arrow keys move between cards; Enter
 * opens the lead. Only one card is in the Tab order (roving focus).
 */
export function PipelineBoard({
  board,
  groups,
  now,
  filtersActive,
  loadingColumns,
  onMove,
  onLoadMore,
  onAnnounce,
}: {
  board: Board
  /** Every group, in sidebar order (the "Move to group…" menu offers them all). */
  groups: GroupDTO[]
  now: string
  filtersActive: boolean
  loadingColumns: ReadonlySet<string>
  /** Resolves false when the move was refused and rolled back. */
  onMove: (card: PipelineCard, fromGroupId: string, toGroupId: string) => Promise<boolean>
  onLoadMore: (groupId: string) => void
  onAnnounce: (text: string) => void
}) {
  const router = useRouter()
  const instructionsId = useId()
  const boardRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ card: PipelineCard; from: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const wantFocus = useRef<string[] | null>(null)
  const dragKey = useRef<string | null>(null)
  const wantFocusAfterMenu = useRef<string[] | null>(null)
  // The card that last had focus on the board, and where it sat.
  const lastFocus = useRef<{ key: string; leadId: string; groupId: string; index: number } | null>(null)

  const keys = board.columns.flatMap((c) => c.cards.map((card) => keyOf(c.group.id, card.leadId)))
  const tabStop = focused && keys.includes(focused) ? focused : (keys[0] ?? null)

  const focusCard = useCallback((key: string): boolean => {
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(key)}"]`)
    if (!el) return false
    setFocused(key)
    el.focus()
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return true
  }, [])

  const focusFirstOf = useCallback((candidates: string[]) => {
    for (const key of candidates) if (focusCard(key)) return
  }, [focusCard])

  // After a move by keyboard or menu, focus follows the card to its new
  // column (or stays in the column it left, when the new one isn't shown).
  useLayoutEffect(() => {
    const want = wantFocus.current
    if (!want) return
    wantFocus.current = null
    focusFirstOf(want)
  })

  // A focused card that goes away in a reload (a chip key took the person out
  // of this column) leaves focus on the page: it goes to the same person's
  // card in another column, else the card that took its place, else the one
  // before it. Not when focus has moved somewhere else on purpose.
  useLayoutEffect(() => {
    const last = lastFocus.current
    if (!last || keys.includes(last.key)) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const elsewhere = board.columns.filter((c) => c.cards.some((x) => x.leadId === last.leadId)).map((c) => keyOf(c.group.id, last.leadId))
    const cards = board.columns.find((c) => c.group.id === last.groupId)?.cards ?? []
    const near = cards.length > 0 ? [keyOf(last.groupId, cards[Math.min(last.index, cards.length - 1)].leadId)] : []
    focusFirstOf([...elsewhere, ...near])
  })

  const move = (card: PipelineCard, from: string, to: string, followFocus: boolean) => {
    if (from === to) return
    let candidates: string[] = []
    if (followFocus) {
      const cards = board.columns.find((c) => c.group.id === from)?.cards ?? []
      const i = cards.findIndex((c) => c.leadId === card.leadId)
      const rest = cards.filter((c) => c.leadId !== card.leadId)
      const stay = rest[Math.min(Math.max(i, 0), rest.length - 1)]
      candidates = [keyOf(to, card.leadId), ...(stay ? [keyOf(from, stay.leadId)] : [])]
      wantFocus.current = candidates
    }
    void onMove(card, from, to).then((moved) => {
      // Refused: the card is back in its column. If focus is still where the
      // move put it (or fell to the page when that card went away), it goes
      // back to the card; if the person has moved on, it stays put.
      if (moved || !followFocus) return
      setTimeout(() => {
        const active = document.activeElement
        const at = active instanceof HTMLElement ? active.getAttribute('data-card-key') : null
        if (!active || active === document.body || (at !== null && candidates.includes(at))) focusFirstOf([keyOf(from, card.leadId)])
      }, 30)
    })
  }

  const focusNeighbor = (groupId: string, leadId: string, within: 'column' | 'row', delta: -1 | 1) => {
    const cols = board.columns
    const ci = cols.findIndex((c) => c.group.id === groupId)
    const ri = ci < 0 ? -1 : cols[ci].cards.findIndex((c) => c.leadId === leadId)
    if (ri < 0) return
    if (within === 'column') {
      const next = cols[ci].cards[ri + delta]
      if (next) focusCard(keyOf(groupId, next.leadId))
      return
    }
    for (let j = ci + delta; j >= 0 && j < cols.length; j += delta) {
      const cards = cols[j].cards
      if (cards.length > 0) {
        focusCard(keyOf(cols[j].group.id, cards[Math.min(ri, cards.length - 1)].leadId))
        return
      }
    }
  }

  const onCardKeyDown = (e: React.KeyboardEvent<HTMLElement>, card: PipelineCard, groupId: string) => {
    // React passes key presses up through portals: keys typed in the card's
    // "Move to…" menu (rendered elsewhere in the page) aren't the card's.
    if (!e.currentTarget.contains(e.target as Node)) return
    const action = cardKeyAction(e, { onCard: e.target === e.currentTarget, editable: isEditableTarget(e.target) })
    if (!action) return
    e.preventDefault()
    if (action.type === 'open') router.push(`/leads/${card.leadId}`)
    else if (action.type === 'menu') setMenuFor(keyOf(groupId, card.leadId))
    else if (action.type === 'focus') focusNeighbor(groupId, card.leadId, action.within, action.delta)
    else {
      const to = neighborGroup(board, groupId, action.dir)
      if (to) move(card, groupId, to, true)
      else onAnnounce(action.dir < 0 ? 'There is no column to the left.' : 'There is no column to the right.')
    }
  }

  const endDrag = () => {
    dragKey.current = null
    setDrag(null)
    setDragging(null)
    setOver(null)
  }

  return (
    <div
      ref={boardRef}
      // Focus that leaves the board on purpose (a click or Tab elsewhere) isn't brought back.
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) lastFocus.current = null
      }}
      data-testid="pipeline-board"
      // Phone width: the columns become a swipeable row, one column per
      // swipe (scroll-snap); wider screens scroll freely.
      className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto p-4 sm:snap-none"
    >
      <p id={instructionsId} className="sr-only">
        Arrow keys move between cards. [ and ] move this person to the column on the left or right. M picks any group.
        Enter opens the lead.
      </p>
      {board.columns.map((col) => {
        const groupId = col.group.id
        const dropHere = drag !== null && drag.from !== groupId && over === groupId
        return (
          <section
            key={groupId}
            data-column={groupId}
            aria-label={`${col.group.name}: ${col.count} ${col.count === 1 ? 'person' : 'people'}`}
            className={cn(
              'flex w-[85vw] max-w-[22rem] shrink-0 snap-start flex-col rounded-lg border bg-bg sm:w-72',
              dropHere ? 'border-accent ring-2 ring-accent' : 'border-line',
            )}
            onDragOver={(e) => {
              if (!drag || drag.from === groupId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (over !== groupId) setOver(groupId)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === groupId ? null : o))
            }}
            onDrop={(e) => {
              e.preventDefault()
              const d = drag
              endDrag()
              if (d && d.from !== groupId) move(d.card, d.from, groupId, false)
            }}
          >
            <header data-column-header={groupId} className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
              <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', groupColorStyle(col.group.color).dot)} />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong">{col.group.name}</h2>
              <span className="shrink-0 rounded-full bg-active px-1.5 text-xs font-medium tabular-nums text-muted">{col.count}</span>
            </header>
            <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {col.cards.map((card) => {
                const key = keyOf(groupId, card.leadId)
                return (
                  <li key={card.leadId}>
                    <CardView
                      card={card}
                      groupId={groupId}
                      groupName={col.group.name}
                      groups={groups}
                      now={now}
                      tabbable={key === tabStop}
                      instructionsId={instructionsId}
                      dragging={dragging === key}
                      menuOpen={menuFor === key}
                      onMenuOpenChange={(open) => {
                        setMenuFor(open ? key : null)
                        // The menu hands focus back to its "⋯" button; the card is where the keys work.
                        if (!open) {
                          setTimeout(() => {
                            const want = wantFocusAfterMenu.current ?? [key]
                            wantFocusAfterMenu.current = null
                            focusFirstOf(want)
                          }, 30)
                        }
                      }}
                      onKeyDown={(e) => onCardKeyDown(e, card, groupId)}
                      onFocus={() => {
                        setFocused(key)
                        lastFocus.current = { key, leadId: card.leadId, groupId, index: col.cards.indexOf(card) }
                      }}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData(DRAG_TYPE, card.leadId)
                        setDrag({ card, from: groupId })
                        dragKey.current = key
                        // A frame later, so the browser's drag image isn't faded too.
                        requestAnimationFrame(() => {
                          if (dragKey.current === key) setDragging(key)
                        })
                      }}
                      onDragEnd={endDrag}
                      onMoveTo={(to) => {
                        move(card, groupId, to, true)
                        wantFocusAfterMenu.current = wantFocus.current && [...wantFocus.current]
                      }}
                      onOpenLead={() => router.push(`/leads/${card.leadId}`)}
                    />
                  </li>
                )
              })}
              {col.cards.length === 0 && (
                <li className="px-2 py-6 text-center text-sm text-subtle">
                  {filtersActive ? 'No one here matches these filters.' : `No one in ${col.group.name} yet.`}
                </li>
              )}
            </ol>
            {col.hasMore && (
              <div className="shrink-0 border-t border-line p-2">
                <Button size="sm" variant="ghost" className="w-full" loading={loadingColumns.has(groupId)} onClick={() => onLoadMore(groupId)}>
                  {`Load more (${col.count - col.cards.length} left)`}
                </Button>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function CardView({
  card,
  groupId,
  groupName,
  groups,
  now,
  tabbable,
  instructionsId,
  dragging,
  menuOpen,
  onMenuOpenChange,
  onKeyDown,
  onFocus,
  onDragStart,
  onDragEnd,
  onMoveTo,
  onOpenLead,
}: {
  card: PipelineCard
  groupId: string
  groupName: string
  groups: GroupDTO[]
  now: string
  tabbable: boolean
  instructionsId: string
  dragging: boolean
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  onFocus: () => void
  onDragStart: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onMoveTo: (groupId: string) => void
  onOpenLead: () => void
}) {
  const due = card.nextTask ? dueText(card.nextTask.dueDate, now) : null
  const others = groups.filter((g) => g.id !== groupId)
  const memberOf = new Set(card.groups.map((g) => g.id))
  return (
    <article
      data-card={card.leadId}
      data-card-key={keyOf(groupId, card.leadId)}
      // PR C's chip keys (1–9) act on the card that has focus.
      data-contact-card=""
      tabIndex={tabbable ? 0 : -1}
      draggable
      aria-describedby={instructionsId}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus()
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'cursor-grab rounded-md border border-line bg-elevated p-2.5 text-sm text-fg shadow-sm transition-opacity active:cursor-grabbing',
        dragging && 'opacity-50',
      )}
    >
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <Link
            href={`/leads/${card.leadId}`}
            tabIndex={-1}
            draggable={false}
            className="block truncate text-base font-medium text-link hover:underline"
          >
            {card.displayName}
          </Link>
          {card.address && <p className="truncate text-muted">{card.address}</p>}
        </div>
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-subtle" title="Place in All leads">
          {`#${card.rank}`}
        </span>
        <DropdownRoot open={menuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownTrigger asChild>
            <IconButton label={`Move ${card.displayName} to another group`} size="sm" tooltip={false} tabIndex={-1}>
              <Ellipsis size={14} />
            </IconButton>
          </DropdownTrigger>
          <DropdownContent align="end">
            <DropdownLabel>Move to</DropdownLabel>
            {others.length === 0 ? (
              <DropdownItem disabled>No other groups yet</DropdownItem>
            ) : (
              others.map((g) => (
                <DropdownItem key={g.id} onSelect={() => onMoveTo(g.id)} shortcut={memberOf.has(g.id) ? 'already in' : undefined}>
                  {g.name}
                </DropdownItem>
              ))
            )}
            <DropdownSeparator />
            <DropdownItem onSelect={onOpenLead} shortcut="Enter">
              Open lead
            </DropdownItem>
          </DropdownContent>
        </DropdownRoot>
      </div>

      {/* Our value estimate (card.value) goes here once Brief 44's data is in
          the CRM; it is always null until then, so there's no line for it. */}
      <div className="mt-1.5 flex flex-col gap-0.5">
        {card.bestBuyer ? (
          <p className="flex min-w-0 items-center gap-1.5">
            <Star size={12} className="shrink-0 text-subtle" aria-hidden />
            <span className="truncate">{card.bestBuyer.name}</span>
            {card.bestBuyer.score != null && <span className="shrink-0 tabular-nums text-muted">{card.bestBuyer.score}</span>}
            {card.bestBuyer.isTestData && <Badge>Test</Badge>}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-subtle">
            <Star size={12} className="shrink-0" aria-hidden />
            No buyer yet
          </p>
        )}
        <p className="flex items-center gap-1.5 text-muted">
          <Clock size={12} className="shrink-0 text-subtle" aria-hidden />
          {lastContactText(card.lastContactAt, now)}
        </p>
        {card.nextTask && (
          <p className="flex min-w-0 items-center gap-1.5">
            <CalendarClock size={12} className="shrink-0 text-subtle" aria-hidden />
            <span className="truncate">{card.nextTask.text}</span>
            {due && <span className={cn('shrink-0', TONE[due.tone])}>{`· ${due.label}`}</span>}
          </p>
        )}
        <p className="flex items-center gap-1.5 text-muted">
          <UsersRound size={12} className="shrink-0 text-subtle" aria-hidden />
          {inGroupText(card.inGroupSince, now, groupName)}
        </p>
      </div>

      <div data-testid="card-groups" className="mt-2 flex flex-wrap gap-1">
        <PipelineGroupChips leadId={card.leadId} groups={card.groups} />
      </div>
      {card.alsoIn.length > 0 && (
        <p data-testid="also-in" className="mt-1.5 flex items-center gap-1 text-xs font-medium text-accent">
          <Layers size={12} className="shrink-0" aria-hidden />
          {`Also in ${card.alsoIn.map((g) => g.name).join(', ')}`}
        </p>
      )}
    </article>
  )
}
