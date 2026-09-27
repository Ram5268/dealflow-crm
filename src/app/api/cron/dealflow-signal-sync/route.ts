import type { NextRequest } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, errorResponse } from '@/lib/shared/http'
import { runDealflowSync } from '@/lib/core-data/dealflow-sync/run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Bearer-protected cron endpoint (fails closed without CRON_SECRET), scheduled
// daily by vercel.json. On RO failure returns 503 and writes nothing; an empty
// or stale DealFlow batch returns ok:false with `skipped` and writes nothing.
export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
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
