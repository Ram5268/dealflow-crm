import { prisma } from '@/lib/compliance/db'
import { addInternalDnc, type AddInternalDncResult } from '@/lib/compliance/dnc/internal'
import type { OptOutMatch } from './opt-out'

// The opt-out list's reason for each kind of match (Brief 41.1, F5): a phrase
// inside a longer message is told apart from a plain STOP, so it can be
// reviewed later.
export const STOP_REASON: Record<OptOutMatch['kind'], string> = {
  keyword: 'sms_stop_received',
  phrase: 'sms_stop_phrase',
}

/**
 * SMS STOP → internal DNC. Brief 41 (H12): written in-process. It used to be an
 * HTTP self-call to the compliance route with no Basic-auth credentials, at a
 * URL that didn't match the compliance base, so a STOP never reached the list.
 * Throws on failure: the webhook then answers non-2xx instead of dropping a
 * legally required opt-out.
 */
export async function handleStop(
  orgId: string,
  phone: string,
  match: OptOutMatch = { kind: 'keyword', phrase: 'stop' },
): Promise<AddInternalDncResult> {
  const result = await addInternalDnc(orgId, {
    phone,
    reason: STOP_REASON[match.kind],
    addedBy: 'sms-inbound-handler',
  })
  // A clear keyword after an earlier phrase match: the number is no longer one
  // to review, so its reason says so.
  if (!result.added && match.kind === 'keyword') {
    await prisma.dncSuppression.updateMany({
      where: { organizationId: orgId, phone: result.phone, source: 'internal', reason: STOP_REASON.phrase },
      data: { reason: STOP_REASON.keyword },
    })
  }
  return result
}
