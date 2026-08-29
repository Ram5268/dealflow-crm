/**
 * Minimal class joiner. Deliberately NOT clsx + tailwind-merge: the sibling
 * DealFlow repo removed both as dead weight, and conflict-resolution is handled
 * by writing variants that do not overlap rather than by merging at runtime.
 */
export type ClassValue = string | false | null | undefined

export function cn(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ')
}
