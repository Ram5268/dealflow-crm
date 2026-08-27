import { NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/comms/oauth/graph'
import { getCurrentOrgId } from '@/lib/shell/orgContext'

export const dynamic = 'force-dynamic'

// Start Microsoft Graph OAuth: redirect to the MSFT consent screen (signed state).
export async function GET() {
  const orgId = await getCurrentOrgId()
  return NextResponse.redirect(getAuthUrl(orgId))
}
