import { NextResponse } from 'next/server'
import { verifyState } from '@/lib/comms/oauth/state'
import { exchangeCode } from '@/lib/comms/oauth/graph'
import { upsertCredential } from '@/lib/comms/oauth/store'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

// MSFT Graph OAuth callback: verify state, exchange code, persist the encrypted
// credential (provider=msft-graph), bounce to settings.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const providerError = url.searchParams.get('error')

  const settings = new URL('/settings/comms', url.origin)
  if (providerError || !code || !state) {
    settings.searchParams.set('error', providerError ?? 'missing_code_or_state')
    return NextResponse.redirect(settings)
  }

  let orgId: string
  try {
    orgId = verifyState(state).orgId
  } catch {
    settings.searchParams.set('error', 'invalid_state')
    return NextResponse.redirect(settings)
  }

  try {
    const tokens = await exchangeCode(code)
    await upsertCredential({
      orgId,
      provider: 'msft-graph',
      emailAddress: tokens.emailAddress,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    })
    settings.searchParams.set('connected', 'msft')
  } catch (err) {
    logger.error({ err }, 'msft oauth callback failed')
    settings.searchParams.set('error', 'exchange_failed')
  }
  return NextResponse.redirect(settings)
}
