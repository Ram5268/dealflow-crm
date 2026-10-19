'use client'

// Brief 45 PR C — the group chips on a lead's contact card [brief §5.3]: on
// the lead page, on each list row (compact) and in the dialer's Ammunition
// card. Every group shows as a chip, in sidebar order. One click adds the lead
// to that group and the chip lights up at once; a second click removes it. No
// menus and no save button. A change the CRM refuses goes back, with a toast
// saying why. "+" makes a new group by name and adds the lead in one step.
// Keys 1–9 toggle the first nine groups while the card has focus (chip-keys.ts).
//
// Groups only organize: nothing here contacts anyone [Ryan, 2026-09-24]. A
// group change never touches the lead's lists [Ryan, 2026-10-18]. PR A's API
// writes the timeline entry ("Added to Hot") for every real change.
//
// Attributes the tests and the post-merge production check read:
// data-testid="group-chips" (the row), data-group-id + aria-pressed (each
// chip), data-testid="group-chip-add" (the "+" chip).

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Plus } from 'lucide-react'
import { useToast } from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { isEditableTarget } from '@/lib/ui/hotkeys'
import { groupColorStyle } from '@/lib/ui/groupColors'
import { useSidebarData } from '@/lib/core-data/lists/client'
import type { GroupChipDTO, GroupDTO, SidebarData } from '@/lib/core-data/lists/types'
import { GroupChipsController, litGroupIds, plainError, type ChipApi } from './group-chips-state'
import { chipKeyLabel, groupForKey } from './chip-keys'

/** The element that counts as "the card" for keys 1–9: one marked data-contact-card, else the table row. */
const CARD_SELECTOR = '[data-contact-card], tr'
const CARD_ATTR = 'data-contact-card'

// ─── The view (pure; the render tests use it) ───────────────────────────────

// min-w-0 + max-w-full: a long name shortens with an ellipsis on a narrow screen.
const CHIP = 'inline-flex min-w-0 max-w-full items-center rounded-full border whitespace-nowrap transition-colors duration-100'
const SIZE = { regular: 'h-6 gap-1 px-2 text-sm', compact: 'h-5 gap-0.5 px-1.5 text-xs' } as const
const OFF = 'border-line bg-elevated text-muted hover:bg-hover hover:text-fg'
const ADD = 'border-dashed border-line-strong bg-transparent text-muted hover:bg-hover hover:text-fg'

/**
 * A chip's classes. Lit: filled in the group's own color (PR B's theme
 * tokens, both themes) with a check mark; not lit: neutral with a small dot
 * in the group's color. Shared with the list rows' first paint (RowGroupChips).
 */
export function chipClassName(color: string, on: boolean, compact: boolean): string {
  const style = groupColorStyle(color)
  return cn(CHIP, SIZE[compact ? 'compact' : 'regular'], on ? cn(style.chip, style.border) : OFF)
}

/** The small dot in the group's color on a chip that isn't lit. */
export function ChipDot({ color }: { color: string }) {
  return <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', groupColorStyle(color).dot)} />
}

export interface GroupChipsViewProps {
  /** Every group in sidebar order; null while they load. */
  groups: readonly GroupChipDTO[] | null
  /** The lit chips (the lead's groups, as shown). */
  lit: readonly string[]
  /** Chips with a change on its way to the CRM. */
  busy?: readonly string[]
  /** Why the groups couldn't load (plain English). */
  loadError?: string | null
  /** Small chips without a label (list rows, Pipeline cards). */
  compact?: boolean
  /** "Groups:" on the lead page and the dialer card. */
  label?: string
  /** Advertise keys 1–9 on the first nine chips. */
  hotkeys?: boolean
  onToggle?: (groupId: string) => void
  /** "+": make the group and add the lead. Resolves to the reason it failed, or null when done. */
  onCreate?: (name: string) => Promise<string | null>
  onRetry?: () => void
  rootRef?: React.Ref<HTMLDivElement>
}

export function GroupChipsView({
  groups,
  lit,
  busy = [],
  loadError,
  compact = false,
  label,
  hotkeys = false,
  onToggle,
  onCreate,
  onRetry,
  rootRef,
}: GroupChipsViewProps) {
  const size = compact ? 'compact' : 'regular'
  return (
    <div
      ref={rootRef}
      data-testid="group-chips"
      data-size={size}
      role="group"
      aria-label="Groups"
      // Compact (list rows): at least 11rem wide, so three groups take two lines
      // and a row stays its natural height instead of growing a line per chip.
      className={cn('flex flex-wrap items-center', compact ? 'min-w-[11rem] gap-1' : 'min-w-0 gap-1.5')}
      // A click or key on a chip belongs to the chip, not to the row or card
      // around it (a list row opens the lead on click/Enter, selects on Space).
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
    >
      {label && <span className="mr-0.5 text-sm text-subtle">{label}</span>}
      {groups === null ? (
        loadError ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className="text-danger">{loadError}</span>
            <button type="button" onClick={onRetry} className="text-link hover:underline">
              Try again
            </button>
          </span>
        ) : (
          <span className="text-xs text-subtle">Loading groups…</span>
        )
      ) : (
        groups.map((g, i) => {
          const on = lit.includes(g.id)
          const key = hotkeys ? chipKeyLabel(i) : null
          return (
            <button
              key={g.id}
              type="button"
              data-group-id={g.id}
              aria-pressed={on}
              aria-busy={busy.includes(g.id) || undefined}
              aria-keyshortcuts={key ?? undefined}
              title={`${on ? 'Remove from' : 'Add to'} ${g.name}${key ? ` (press ${key})` : ''}`}
              onClick={() => onToggle?.(g.id)}
              className={chipClassName(g.color, on, compact)}
            >
              {on ? <Check size={compact ? 10 : 12} aria-hidden="true" className="shrink-0" /> : <ChipDot color={g.color} />}
              <span className="min-w-0 max-w-[13rem] truncate">{g.name}</span>
            </button>
          )
        })
      )}
      <NewGroupChip compact={compact} first={groups !== null && groups.length === 0} onCreate={onCreate} />
    </div>
  )
}

/** "+": type a name, Enter makes the group and adds the lead; Esc cancels. */
function NewGroupChip({
  compact,
  first,
  onCreate,
}: {
  compact: boolean
  first: boolean
  onCreate?: (name: string) => Promise<string | null>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const errorId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus()
  }, [editing])

  const close = (returnFocus: boolean) => {
    refocus.current = returnFocus
    setEditing(false)
    setName('')
    setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !onCreate) return
    setSaving(true)
    const problem = await onCreate(name)
    setSaving(false)
    if (problem) setError(problem)
    else close(true)
  }

  if (!editing) {
    return (
      <button
        ref={buttonRef}
        type="button"
        data-testid="group-chip-add"
        aria-label="New group"
        title="Make a new group and add this person to it"
        onClick={() => setEditing(true)}
        className={cn(CHIP, SIZE[compact ? 'compact' : 'regular'], ADD)}
      >
        <Plus size={compact ? 10 : 12} aria-hidden="true" className="shrink-0" />
        {first && <span>New group</span>}
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          // These keys belong to the box, not to a list row around it.
          if (['Enter', ' ', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            close(true)
          }
        }}
        onBlur={() => {
          if (!name.trim() && !saving) close(false)
        }}
        readOnly={saving}
        aria-busy={saving || undefined}
        placeholder="New group name"
        aria-label="New group name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          'rounded-full border bg-elevated text-fg outline-none placeholder:text-subtle',
          error ? 'border-danger' : 'border-line focus:border-accent',
          compact ? 'h-5 w-28 px-1.5 text-xs' : 'h-6 w-40 px-2 text-sm',
        )}
      />
      {error && (
        <span id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </form>
  )
}

// ─── The live chips ──────────────────────────────────────────────────────────

export interface GroupChipsProps {
  leadId: string
  /**
   * The lead's groups (ids). When the page passes new values (e.g. rows
   * reloaded after a bulk change) they replace what the chips know; a click
   * still on its way keeps showing.
   */
  memberOf: string[]
  /** Small chips without the "Groups:" label (list rows, Pipeline cards). */
  compact?: boolean
  /** Keys 1–9 toggle the first nine groups while this card has focus. */
  hotkeys?: boolean
  /** After a burst of clicks has reached the CRM: the lead's groups, in sidebar order. */
  onChange?(memberOf: string[]): void
  /**
   * How the chips reach the CRM (default: PR A's routes). The Pipeline passes
   * one that waits for that person's card moves, so a chip and a move of the
   * same person can't land out of order (PR D).
   */
  api?: ChipApi
}

function chipGroups(groups: readonly GroupDTO[]): GroupChipDTO[] {
  return groups.map(({ id, name, color }) => ({ id, name, color }))
}

function inOrder(ids: string[], groups: readonly GroupChipDTO[] | null): string[] {
  if (!groups) return ids
  const at = new Map(groups.map((g, i) => [g.id, i]))
  const pos = (id: string) => at.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...ids].sort((a, b) => pos(a) - pos(b))
}

export function GroupChips({ leadId, memberOf, compact = false, hotkeys = false, onChange, api }: GroupChipsProps) {
  const sidebar = useSidebarData()
  const { toast } = useToast()

  // Groups made here with "+" show at once, until the sidebar's reload has them.
  const [made, setMade] = useState<{ basis: SidebarData | null; groups: GroupChipDTO[] }>({ basis: null, groups: [] })
  const groups = useMemo(() => {
    if (!sidebar.data) return null
    const list = chipGroups(sidebar.data.groups)
    const extra = made.basis === sidebar.data ? made.groups.filter((m) => !list.some((g) => g.id === m.id)) : []
    return [...list, ...extra]
  }, [sidebar.data, made])

  const latest = useRef({ onChange, toast, groups, data: sidebar.data, reload: sidebar.reload })
  useEffect(() => {
    latest.current = { onChange, toast, groups, data: sidebar.data, reload: sidebar.reload }
  })

  const makeController = (id: string, initial: readonly string[]) =>
    new GroupChipsController({
      leadId: id,
      memberOf: initial,
      api,
      onError: (e) => {
        const name = latest.current.groups?.find((g) => g.id === e.groupId)?.name ?? 'that group'
        latest.current.toast({
          tone: 'danger',
          title: e.value ? `Couldn't add to ${name}` : `Couldn't remove from ${name}`,
          description: e.message,
        })
        // Deleted somewhere else: show the groups as they are now.
        if (e.status === 404) void latest.current.reload()
      },
      onSettled: (ids) => latest.current.onChange?.(inOrder(ids, latest.current.groups)),
    })

  // One controller per lead; another lead gets fresh chips.
  const [controller, setController] = useState(() => makeController(leadId, memberOf))
  if (controller.leadId !== leadId) setController(makeController(leadId, memberOf))

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  // New rows from the page (by value, not by array identity).
  const memberKey = [...memberOf].sort().join(' ')
  useEffect(() => {
    controller.reset(memberOf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, memberKey])

  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hotkeys) return
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current
      if (!root) return
      const card = root.closest(CARD_SELECTOR) ?? root
      const target = e.target instanceof Node ? e.target : null
      const nothingFocused = target === null || target === document.body || target === document.documentElement
      const group = groupForKey(
        e,
        {
          editable: isEditableTarget(e.target),
          inCard: target !== null && card.contains(target),
          pageFocus: nothingFocused && card.getAttribute(CARD_ATTR) === 'page',
        },
        latest.current.groups ?? [],
      )
      if (!group) return
      e.preventDefault()
      controller.toggle(group.id)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [hotkeys, controller])

  const create = useCallback(
    async (name: string): Promise<string | null> => {
      const basis = latest.current.data
      try {
        const group = await controller.createAndAdd(name)
        const chip = { id: group.id, name: group.name, color: group.color }
        setMade((m) => ({ basis, groups: m.basis === basis ? [...m.groups, chip] : [chip] }))
        return null
      } catch (err) {
        return plainError(err).message
      }
    },
    [controller],
  )

  const order = groups?.map((g) => g.id) ?? []
  return (
    <GroupChipsView
      rootRef={rootRef}
      groups={groups}
      lit={litGroupIds(state, order)}
      busy={Object.keys(state.sending)}
      loadError={sidebar.data ? null : sidebar.error}
      compact={compact}
      label={compact ? undefined : 'Groups:'}
      hotkeys={hotkeys}
      onToggle={(id) => controller.toggle(id)}
      onCreate={create}
      onRetry={() => void sidebar.reload()}
    />
  )
}
