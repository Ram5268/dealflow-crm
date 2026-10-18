import { GROUP_COLORS, type GroupColor } from '@/lib/core-data/lists/types'

/**
 * Brief 45 — a group's color as theme-token classes. The tokens
 * (`--group-<color>`, `-subtle`, `-fg`) live in globals.css for both themes, so
 * a group reads correctly in light and dark (docs/ui-notes.md: never raw
 * colors). Shared by the sidebar, the list pages, the group chips (PR C) and
 * the Pipeline (PR D).
 *
 * The class strings are written out in full on purpose: Tailwind only
 * generates utilities it can find verbatim in the source.
 */
export interface GroupColorStyle {
  /** Plain name for menus ("Red"). */
  label: string
  /** The solid dot. */
  dot: string
  /** A filled chip or badge: subtle background, readable text. */
  chip: string
  /** A border in the group's color (a chip that is "on"). */
  border: string
}

export const GROUP_COLOR_STYLES: Record<GroupColor, GroupColorStyle> = {
  gray: { label: 'Gray', dot: 'bg-group-gray', chip: 'bg-group-gray-subtle text-group-gray-fg', border: 'border-group-gray' },
  red: { label: 'Red', dot: 'bg-group-red', chip: 'bg-group-red-subtle text-group-red-fg', border: 'border-group-red' },
  orange: { label: 'Orange', dot: 'bg-group-orange', chip: 'bg-group-orange-subtle text-group-orange-fg', border: 'border-group-orange' },
  yellow: { label: 'Yellow', dot: 'bg-group-yellow', chip: 'bg-group-yellow-subtle text-group-yellow-fg', border: 'border-group-yellow' },
  green: { label: 'Green', dot: 'bg-group-green', chip: 'bg-group-green-subtle text-group-green-fg', border: 'border-group-green' },
  teal: { label: 'Teal', dot: 'bg-group-teal', chip: 'bg-group-teal-subtle text-group-teal-fg', border: 'border-group-teal' },
  blue: { label: 'Blue', dot: 'bg-group-blue', chip: 'bg-group-blue-subtle text-group-blue-fg', border: 'border-group-blue' },
  purple: { label: 'Purple', dot: 'bg-group-purple', chip: 'bg-group-purple-subtle text-group-purple-fg', border: 'border-group-purple' },
  pink: { label: 'Pink', dot: 'bg-group-pink', chip: 'bg-group-pink-subtle text-group-pink-fg', border: 'border-group-pink' },
}

/** The style for a stored color; anything unexpected reads as gray rather than breaking. */
export function groupColorStyle(color: string | null | undefined): GroupColorStyle {
  return (GROUP_COLORS as readonly string[]).includes(color ?? '')
    ? GROUP_COLOR_STYLES[color as GroupColor]
    : GROUP_COLOR_STYLES.gray
}

/** Every color in the API's order, for a color picker. */
export const GROUP_COLOR_OPTIONS: ({ value: GroupColor } & GroupColorStyle)[] = GROUP_COLORS.map((value) => ({
  value,
  ...GROUP_COLOR_STYLES[value],
}))
