import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getTemplate, updateTemplate, deleteTemplate, TemplateInUseError } from '@/lib/comms/templates/crud'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, ctx: Ctx) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  const t = await getTemplate(orgId, id)
  return t ? NextResponse.json(t) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}

export async function PATCH(req: Request, ctx: Ctx) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params
  try {
    const t = await updateTemplate(orgId, id, await req.json())
    return t ? NextResponse.json(t) : NextResponse.json({ error: 'not_found' }, { status: 404 })
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
  try {
    await deleteTemplate(orgId, id)
    return NextResponse.json({ deleted: true })
  } catch (err) {
    if (err instanceof TemplateInUseError) {
      return NextResponse.json({ error: err.code }, { status: 409 })
    }
    throw err
  }
}
