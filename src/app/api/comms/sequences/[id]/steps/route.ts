import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { listSteps } from '@/lib/comms/sequences/crud'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  return NextResponse.json({ steps: await listSteps(orgId, id) })
}
