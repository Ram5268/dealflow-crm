import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { createSequence, listSequences } from '@/lib/comms/sequences/crud'

export const dynamic = 'force-dynamic'

export async function GET() {
  const orgId = await getCurrentOrgId()
  return NextResponse.json({ sequences: await listSequences(orgId) })
}

export async function POST(req: Request) {
  const orgId = await getCurrentOrgId()
  try {
    return NextResponse.json(await createSequence(orgId, await req.json()), { status: 201 })
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    throw err
  }
}
