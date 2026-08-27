import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { CALLABLE_NOW_MAX, runCallableNow } from '@/lib/compliance/scrub/callableNow'
import { makeCallableNowDeps } from '@/lib/compliance/scrub/callableNowDeps'
import { BatchTooLargeError } from '@/lib/compliance/errors'

export const dynamic = 'force-dynamic'

// POST /api/compliance/callable-now — the hot path. Called inline by Agent B
// before every dial. Batch cap 100 -> 413. Any internal failure returns 500,
// which Agent B is required to treat as callable:false (fail-closed).
export async function POST(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const ids = body?.contactPhoneIds
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    return NextResponse.json({ error: 'contactPhoneIds must be a string[]' }, { status: 400 })
  }
  if (ids.length > CALLABLE_NOW_MAX) {
    return NextResponse.json(
      { error: 'batch_too_large', maxItems: CALLABLE_NOW_MAX, receivedItems: ids.length },
      { status: 413, headers: { [CORRELATION_HEADER]: correlationId } }
    )
  }

  try {
    const orgId = await getCurrentOrgId()
    const deps = makeCallableNowDeps({ orgId, correlationId, now: new Date() })
    const result = await runCallableNow({ contactPhoneIds: ids, atInstant: body?.atInstant }, deps)
    return NextResponse.json(result, { headers: { [CORRELATION_HEADER]: correlationId } })
  } catch (err) {
    if (err instanceof BatchTooLargeError) {
      return NextResponse.json(
        { error: 'batch_too_large', maxItems: err.maxItems, receivedItems: err.receivedItems },
        { status: 413 }
      )
    }
    // Fail-closed contract: a 500 here MUST be treated by Agent B as
    // callable:false for every id in the batch.
    log.error({ err: String(err) }, 'callable-now failed; Agent B must treat as fail-closed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
