import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { createTemplate, listTemplates } from '@/lib/comms/templates/crud'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const orgId = await getCurrentOrgId()
  const channel = new URL(req.url).searchParams.get('channel') ?? undefined
  return NextResponse.json({ templates: await listTemplates(orgId, channel) })
}

export async function POST(req: Request) {
  const orgId = await getCurrentOrgId()
  try {
    return NextResponse.json(await createTemplate(orgId, await req.json()), { status: 201 })
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    throw err
  }
}
