import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getSequence, updateSequence, deleteSequence } from '@/lib/comms/sequences/crud'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, ctx: Ctx) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  const s = await getSequence(orgId, id)
  return s ? NextResponse.json(s) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}

export async function PATCH(req: Request, ctx: Ctx) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  try {
    await updateSequence(orgId, id, await req.json())
    return NextResponse.json(await getSequence(orgId, id))
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    throw err
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  await deleteSequence(orgId, id)
  return NextResponse.json({ deleted: true })
}
