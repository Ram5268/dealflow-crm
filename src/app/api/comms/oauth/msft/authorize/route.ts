import { NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/comms/oauth/graph'
import { graphEnabled, graphDisabledResponse } from '@/lib/comms/graph-switch'
import { getCurrentOrgId } from '@/lib/shell/orgContext'

export const dynamic = 'force-dynamic'

// Start Microsoft Graph OAuth: redirect to the MSFT consent screen (signed state).
export async function GET() {
  // Brief 41.2: Outlook is paused (Ryan's instruction). Refuse before anything
  // else, so nothing sends the browser to Microsoft.
  if (!graphEnabled()) return graphDisabledResponse()
  const orgId = await getCurrentOrgId()
  return NextResponse.redirect(getAuthUrl(orgId))
}
