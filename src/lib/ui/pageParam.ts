import { MAX_PAGE } from '@/lib/core-data/lists/types'

/**
 * Brief 45 — a page number from the URL (?page=): a whole number from 1 to
 * MAX_PAGE; anything else (missing, "abc", a 20-digit number) is page 1, the
 * same rule as the lists API's parser. A huge page must never reach a query:
 * it would overflow the database's OFFSET and answer 500 [engineering
 * precaution]. Pure, for the list page and the Leads page.
 */
export function pageParam(raw: string | string[] | null | undefined): number {
  const n = Number.parseInt((Array.isArray(raw) ? raw[0] : raw) ?? '1', 10)
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1
}
