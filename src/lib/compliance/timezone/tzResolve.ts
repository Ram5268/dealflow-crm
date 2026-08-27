import { prisma as defaultPrisma } from '@/lib/compliance/db'
import { TimezoneUnresolvedError } from '@/lib/compliance/errors'

// Contact -> IANA timezone. Reads the raw Contact.timezone column and NOTHING
// else. There is NO fallback to NYC_TIMEZONE_DEFAULT — that is deliberate and
// load-bearing. Agents A and D may render a display-layer "ET" for null-tz
// contacts, but that fallback does not reach here: a missing timezone means we
// cannot know the local calling window, so we fail-closed with
// `timezone_unresolved`.
//
// Presence-only: an invalid-but-present string (e.g. "Etc/Weird") is NOT
// rejected here — it flows to evaluateCallingWindow which fails-closed with
// `timezone_invalid`. This split keeps the two failure modes distinct in the
// audit trail (§11).

export function resolveTimezone(raw: string | null | undefined): string {
  if (raw == null) throw new TimezoneUnresolvedError()
  const trimmed = raw.trim()
  if (trimmed === '') throw new TimezoneUnresolvedError()
  return trimmed
}

type TzReader = { contact: { findUnique: (args: any) => Promise<{ timezone: string | null } | null> } }

export async function tzResolveByContactId(
  contactId: string,
  db: TzReader = defaultPrisma as unknown as TzReader
): Promise<string> {
  const row = await db.contact.findUnique({ where: { id: contactId }, select: { timezone: true } })
  if (!row) throw new TimezoneUnresolvedError({ contactId, missing: 'contact' })
  try {
    return resolveTimezone(row.timezone)
  } catch {
    throw new TimezoneUnresolvedError({ contactId })
  }
}
