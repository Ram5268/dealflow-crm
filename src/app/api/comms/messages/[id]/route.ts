import { NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

/**
 * Inbox read/archive state (Agent E, planner-approved §13 amendment).
 *
 * Both fields are timestamps, not booleans: an ISO-8601 string sets the flag,
 * `null` clears it, and OMITTING a field leaves it untouched. That makes the two
 * flags independent and the whole call idempotent — replaying the same PATCH is
 * a no-op.
 *
 * Deliberately does not touch `status`, which is Agent D's outbound delivery
 * state (outbox | scheduled | sent).
 */
const patchSchema = z.object({
  readAt: z.string().datetime().nullable().optional(),
  archivedAt: z.string().datetime().nullable().optional(),
})

export async function PATCH(req: Request, ctx: Ctx) {
  const orgId = await getCurrentOrgId()
  const { id } = await ctx.params

  let body: z.infer<typeof patchSchema>
  try {
    body = patchSchema.parse(await req.json().catch(() => ({})))
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    throw err
  }

  const data = {
    ...(body.readAt !== undefined
      ? { readAt: body.readAt === null ? null : new Date(body.readAt) }
      : {}),
    ...(body.archivedAt !== undefined
      ? { archivedAt: body.archivedAt === null ? null : new Date(body.archivedAt) }
      : {}),
  }

  // `update` keys on id alone, so scope the write with updateMany + count to
  // keep the org boundary intact.
  const res = await prisma.message.updateMany({ where: { id, organizationId: orgId }, data })
  if (res.count === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json(await prisma.message.findUnique({ where: { id } }))
}
