import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { updateEnrollment } from '@/lib/comms/sequences/crud'
import { SequenceChannelOffError, sequenceChannelOffResponse } from '@/lib/comms/sequences/channel-gate'

export const dynamic = 'force-dynamic'

// Pause / resume / cancel an enrollment. { status: 'paused'|'active'|'cancelled' }.
// Brief 41.2 (PR E): resume answers 403 while a channel the sequence uses is off;
// nothing is saved. Pause and cancel stay allowed. Engineering precaution (audit
// H15), serving Ryan's instruction that nothing contacts a lead: a resumed
// enrollment would fire at switch-on just like a new one.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  try {
    await updateEnrollment(orgId, id, await req.json())
    return NextResponse.json({ id, updated: true })
  } catch (err) {
    if (err instanceof SequenceChannelOffError) return sequenceChannelOffResponse(err)
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    throw err
  }
}
