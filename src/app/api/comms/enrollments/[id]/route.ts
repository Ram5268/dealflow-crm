import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { updateEnrollment } from '@/lib/comms/sequences/crud'

export const dynamic = 'force-dynamic'

// Pause / resume / cancel an enrollment. { status: 'paused'|'active'|'cancelled' }.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  try {
    await updateEnrollment(orgId, id, await req.json())
    return NextResponse.json({ id, updated: true })
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    throw err
  }
}
