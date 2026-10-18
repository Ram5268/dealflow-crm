// Brief 45 — small pieces the /api/core-data list routes share: the ranked
// list query string, the folder body (no nesting), and the CSV response.
import { NextResponse, type NextRequest } from 'next/server'
import type { z } from 'zod'
import { HttpError, parseBody } from '@/lib/shared/http'
import { CORRELATION_HEADER } from '@/lib/shell/correlationId'
import { BOROUGHS, MAX_PAGE, type MemberFilters } from './types'

export const FOLDERS_HOLD_LISTS_ONLY = "Folders hold lists only: a folder can't go inside another folder."

/**
 * parseBody for folder routes: any field besides the name (a parent, a
 * folderId, ...) is refused with the plain reason [Ryan, 2026-10-18: folders
 * can't contain folders].
 */
export async function parseFolderBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  try {
    return await parseBody(req, schema)
  } catch (err) {
    const issues = (err instanceof HttpError ? err.extra?.issues : undefined) as { code?: string }[] | undefined
    if (issues?.some((i) => i.code === 'unrecognized_keys')) throw new HttpError(400, FOLDERS_HOLD_LISTS_ONLY, { issues })
    throw err
  }
}

function flag(sp: URLSearchParams, key: string): true | undefined {
  const v = sp.get(key)?.trim()
  if (!v || v === '0' || v === 'false') return undefined
  if (v === '1' || v === 'true') return true
  throw new HttpError(400, `Unknown ${key} value: ${v.slice(0, 40)}.`)
}

/** `?page=&q=&group=<id>|none&strongBuyer=1&calledToday=1&borough=&ids=1` */
export function parseMemberQuery(sp: URLSearchParams): { page: number; filters: MemberFilters; ids: boolean } {
  const filters: MemberFilters = {}
  const q = sp.get('q')?.trim()
  if (q) filters.q = q.slice(0, 200)
  const group = sp.get('group')?.trim()
  if (group) filters.group = group
  if (flag(sp, 'strongBuyer')) filters.strongBuyer = true
  if (flag(sp, 'calledToday')) filters.calledToday = true
  const borough = sp.get('borough')?.trim()
  if (borough) {
    const canonical = BOROUGHS.find((b) => b.toLowerCase() === borough.toLowerCase())
    if (!canonical) throw new HttpError(400, `Unknown borough: ${borough.slice(0, 40)}.`)
    filters.borough = canonical
  }
  const page = Number.parseInt(sp.get('page') ?? '1', 10)
  // A whole number from 1 to MAX_PAGE; anything else is page 1. A 20-digit
  // page would overflow the database's OFFSET (a 500) [engineering precaution].
  const pageOk = Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE
  return { page: pageOk ? page : 1, filters, ids: flag(sp, 'ids') === true }
}

export function csvResponse(
  out: { filename: string; csv: string; truncated: boolean },
  correlationId: string,
): NextResponse {
  const res = new NextResponse(out.csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${out.filename}"`,
      'cache-control': 'no-store',
      ...(out.truncated ? { 'x-export-truncated': 'true' } : {}),
    },
  })
  res.headers.set(CORRELATION_HEADER, correlationId)
  return res
}
