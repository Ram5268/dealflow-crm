import { NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/comms/oauth/gmail'
import { getCurrentOrgId } from '@/lib/shell/orgContext'

export const dynamic = 'force-dynamic'

// Kick off Gmail OAuth: redirect to Google's consent screen with a signed state.
export async function GET() {
  const orgId = await getCurrentOrgId()
  return NextResponse.redirect(getAuthUrl(orgId))
}
