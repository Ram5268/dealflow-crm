import { DateTime } from 'luxon'
import { DISPLAY_TZ } from './time'

/**
 * Brief 50 PR 14 (open item 6.16): a lead's Source in words. The importer
 * stamps Lead.source "import:<importBatchId>" (commit-worker), which showed as
 * a raw id on the lead page and the leads table; leads added in the CRM say
 * "manual". Display only: the stored value is unchanged, because the importer,
 * the ranking and the compliance scrub all match on it.
 *
 * Safe for client components (no Prisma); the pages look the uploads up with
 * loadUploads (src/lib/core-data/leads/uploads.ts).
 */

/** An upload's "Source label" (typed on the Import page, "Mojo Export" by default), its file name and when it was uploaded (ISO, so it can cross to the client). */
export interface UploadInfo {
  label: string
  filename: string
  createdAt: string
}

/** Keyed by import id. */
export type Uploads = Record<string, UploadInfo>

const IMPORT_PREFIX = 'import:'

/** "import:<id>" → the id; anything else → null. */
export function importIdOf(source: string | null | undefined): string | null {
  if (!source?.startsWith(IMPORT_PREFIX)) return null
  return source.slice(IMPORT_PREFIX.length).trim() || null
}

/** Each import named by these sources, once. */
export function importIdsOf(sources: Iterable<string | null | undefined>): string[] {
  const ids = new Set<string>()
  for (const source of sources) {
    const id = importIdOf(source)
    if (id) ids.add(id)
  }
  return [...ids]
}

/**
 * A lead's Source in words. An upload reads as the "Source label" typed on the
 * Import page ("Mojo Export"), or with `detail` (the lead page and the table's
 * hover text) "Mojo Export · uploaded Oct 18, 2026 · sellers.csv". "Upload"
 * when the upload can't be looked up, "Added by hand" for a lead made in the
 * CRM, any other text as it is, null when there's none. Dates are New York
 * time, like every date on screen.
 */
export function sourceLabel(
  source: string | null | undefined,
  uploads?: Uploads,
  opts: { detail?: boolean } = {},
): string | null {
  const s = source?.trim()
  if (!s) return null
  if (s === 'manual') return 'Added by hand'
  if (!s.startsWith(IMPORT_PREFIX)) return s
  const id = importIdOf(s)
  const info = id ? uploads?.[id] : undefined
  if (!info) return 'Upload'
  const label = info.label.trim()
  if (!opts.detail && label) return label
  const at = DateTime.fromISO(info.createdAt).setZone(DISPLAY_TZ)
  const day = at.isValid ? ` ${at.toFormat('LLL d, yyyy')}` : ''
  const parts = label ? [label, `uploaded${day}`] : [`Uploaded${day}`]
  const file = info.filename.trim()
  return [...parts, ...(file ? [file] : [])].join(' · ')
}
