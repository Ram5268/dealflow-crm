import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getHealth } from '@/lib/shared/health'

export const dynamic = 'force-dynamic'

export const GET = withRoute(async (_req: NextRequest, { correlationId }) => {
  const report = await getHealth()
  const status = report.status === 'down' ? 503 : 200
  return json(report, correlationId, { status })
})
