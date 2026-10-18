import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { scoreNextChunk } from '@/lib/core-data/dealflow-score/driver'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// One chunk waits up to 280 s for DealFlow (a 500-lead chunk took 11–22 s on
// the Railway test database), inside Vercel's 300 s.
export const maxDuration = 300

// POST /api/imports/:id/score — Brief 45 PR F (CONTRACT §7). The import
// progress page calls this again and again once the upload has finished:
// each call sends the next ≤ 500 new people to DealFlow and writes their
// ranks. Body { after?: <cursor from the last call> } →
// { done, next, scored, notRanked, skipped, remaining, retry?, error? }.
// Behind the Basic auth gate like every page; nothing here contacts anyone.
const bodySchema = z.strictObject({
  after: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
})

export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json(await scoreNextChunk(organizationId, params!.id, body.after ?? null), correlationId)
})
