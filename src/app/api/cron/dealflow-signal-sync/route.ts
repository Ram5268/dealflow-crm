import type { NextRequest } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, errorResponse } from '@/lib/shared/http'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { runDealflowSync } from '@/lib/core-data/dealflow-sync/run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Bearer-protected cron endpoint (fails closed without CRON_SECRET), scheduled
// daily by vercel.json. On RO failure returns 503 and writes nothing; an empty
// or stale DealFlow batch, or one that matches no CRM lead or too few (Brief 50
// PR 11), returns ok:false with `skipped` and writes nothing.
// Brief 50 (PR 11), engineering precaution (open item 6.11): the job key is
// checked by the shared constant-time check the other crons use, which takes
// exactly `Bearer <CRON_SECRET>` (what Vercel's cron sends).
export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  if (!isAuthorizedCron(req)) {
    return errorResponse('Unauthorized', 401, correlationId)
  }

  const organizationId = await getCurrentOrgId()
  try {
    const result = await runDealflowSync(organizationId)
    return json({ ok: !result.skipped, ...result }, correlationId)
  } catch (err) {
    return errorResponse('DealFlow RO sync failed', 503, correlationId, {
      detail: err instanceof Error ? err.message : String(err),
    })
  }
})
