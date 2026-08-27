import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { enrollContact, DuplicateEnrollmentError } from '@/lib/comms/sequences/crud'

export const dynamic = 'force-dynamic'

// Enroll a contact in a sequence. { sequenceId, contactId } → enrollment.
export async function POST(req: Request) {
  const orgId = await getCurrentOrgId()
  try {
    const enrollment = await enrollContact(orgId, await req.json())
    return NextResponse.json(
      {
        enrollmentId: enrollment.id,
        currentStepId: enrollment.currentStepId,
        status: enrollment.status,
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation', issues: err.issues }, { status: 400 })
    }
    if (err instanceof DuplicateEnrollmentError) {
      return NextResponse.json({ error: err.code }, { status: 409 })
    }
    if (err instanceof Error && /not found/.test(err.message)) {
      return NextResponse.json({ error: 'not_found', detail: err.message }, { status: 404 })
    }
    throw err
  }
}
