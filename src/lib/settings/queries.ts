import 'server-only'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getCredential, type OAuthProvider } from '@/lib/comms/oauth/store'
import { getPolicyStatus } from '@/lib/compliance/policy/status'
import { evaluateCallingWindow } from '@/lib/compliance/timezone/windowCheck'
import { monthlyCapStatus } from '@/lib/telephony/cost/monthlyCap'
import { getEnv, isDncVendorConfigured, isLitigatorVendorConfigured } from '@/lib/compliance/env'
import { graphEnabled } from '@/lib/comms/graph-switch'
import { isMailboxConnected, mailboxCardActions, type MailboxCardActions } from '@/lib/settings/format'

/* ---------------------------------------------------------------- profile -- */

export interface ProfileInfo {
  displayName: string
  email: string | null
  timezone: string
  /** Where each value came from, so the page can caption it honestly. */
  source: { name: 'db' | 'env' | 'fallback'; email: 'db' | 'none' }
}

/**
 * There is no UserProfile model and no auth, so profile is READ-ONLY (M5 §4).
 * The brief suggested reading the display name from USER_DISPLAY_NAME, but a
 * real `User` row exists (single seat) and is the truer source — env is kept as
 * the fallback so this never disagrees with the sidebar, which reads the env.
 */
export async function getProfileInfo(): Promise<ProfileInfo> {
  const organizationId = await getCurrentOrgId()
  const user = await prisma.user.findFirst({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
    select: { displayName: true, email: true },
  })

  if (user) {
    return {
      displayName: user.displayName,
      email: user.email,
      timezone: getEnv().NYC_TIMEZONE_DEFAULT,
      source: { name: 'db', email: 'db' },
    }
  }
  const envName = process.env.USER_DISPLAY_NAME
  return {
    displayName: envName || 'You',
    email: null,
    timezone: getEnv().NYC_TIMEZONE_DEFAULT,
    source: { name: envName ? 'env' : 'fallback', email: 'none' },
  }
}

/* ------------------------------------------------------- connected accounts -- */

export interface MailboxAccount extends MailboxCardActions {
  /** URL-facing provider name — the segment /api/oauth/[provider]/revoke wants. */
  key: 'gmail' | 'outlook'
  label: string
  /** The value stored in OAuthCredential.provider. */
  stored: OAuthProvider
  connected: boolean
  emailAddress: string | null
  status: string | null
  /** Credential row mtime. NOT a sync timestamp — see the note in the page. */
  updatedAt: Date | null
  /** True once a delta cursor exists, i.e. at least one sync has run. */
  hasSyncCursor: boolean
  authorizeHref: string
  /** Provider-side revocation is Gmail-only; AAD exposes no RFC 7009 endpoint. */
  remoteRevocation: boolean
}

/**
 * READ ONLY. Never write OAuthCredential from app code, a seed, or a test —
 * `upsertCredential` keys on (organizationId, provider) and silently overwrites
 * a live token in place (fleet landmine, M3).
 *
 * Note the provider-name asymmetry: the authorize routes are keyed `gmail` and
 * `msft`, the revoke route is keyed `gmail` and `outlook`, and the DB column
 * holds `gmail` / `msft-graph`. All three are carried explicitly rather than
 * derived, because deriving one from another is what makes this class of bug.
 */
export async function getMailboxAccounts(): Promise<MailboxAccount[]> {
  const organizationId = await getCurrentOrgId()
  // Brief 41.2: the Outlook switch is read here, on the server; the page only
  // gets the resulting card state (mailboxCardActions), never the setting.
  const switches = { graphEnabled: graphEnabled() }

  const specs = [
    {
      key: 'gmail' as const,
      label: 'Gmail',
      stored: 'gmail' as OAuthProvider,
      authorizeHref: '/api/comms/oauth/gmail/authorize',
      remoteRevocation: true,
    },
    {
      key: 'outlook' as const,
      label: 'Outlook',
      stored: 'msft-graph' as OAuthProvider,
      authorizeHref: '/api/comms/oauth/msft/authorize',
      remoteRevocation: false,
    },
  ]

  return Promise.all(
    specs.map(async (spec) => {
      const cred = await getCredential(organizationId, spec.stored)
      const connected = isMailboxConnected(cred)
      return {
        ...spec,
        connected,
        ...mailboxCardActions({ ...spec, connected }, switches),
        // A revoked row keeps its emailAddress, so gate on `connected` — else a
        // disconnected card would still display the address it used to sync.
        emailAddress: connected ? (cred?.emailAddress ?? null) : null,
        status: cred?.status ?? null,
        updatedAt: cred?.updatedAt ?? null,
        hasSyncCursor: connected && Boolean(cred?.gmailHistoryId || cred?.graphDeltaLink),
      }
    }),
  )
}

/* ------------------------------------------------------------- compliance -- */

export interface CallingWindowPreview {
  timezone: string
  confirmed: boolean
  earliestHour: number | null
  latestHour: number | null
  allowedDaysOfWeek: number[]
  openNow: boolean
  /** Populated only when the window is closed AND a policy is confirmed. */
  closedReason: string | null
  confirmedBy: string | null
  confirmedAt: string | null
}

export interface ComplianceInfo {
  windows: CallingWindowPreview[]
  unconfirmedTimezones: string[]
  defaultTimezone: string
  vendors: Array<{ name: string; value: string; configured: boolean; note: string }>
}

/**
 * The calling-window preview (M5 §7), computed from C's own policy status and
 * window evaluator — never re-derived here.
 *
 * The brief asked this to read "Right now you can call between 8am-9pm
 * America/New_York today". That sentence cannot be printed unconditionally:
 * C's gate blocks EVERY number in a timezone with no confirmed
 * CallingWindowConfig row ("never bypassed in tests or dev"), and this org
 * currently has zero rows. Printing calling hours in that state would tell Ryan
 * he may dial when every call would in fact be rejected `policy_unconfirmed` —
 * so the unconfirmed case renders as blocked, and hours are shown only when a
 * confirmed row supplies them. See §13.6.
 */
export async function getComplianceInfo(at = new Date()): Promise<ComplianceInfo> {
  const organizationId = await getCurrentOrgId()
  const status = await getPolicyStatus(organizationId)
  const env = getEnv()
  const defaultTimezone = env.NYC_TIMEZONE_DEFAULT

  const windows: CallingWindowPreview[] = status.configs.map((c) => {
    const confirmed = Boolean(c.policyConfirmedBy)
    const win = evaluateCallingWindow({
      atInstant: at,
      timezone: c.timezone,
      earliestHour: c.earliestHour,
      latestHour: c.latestHour,
      allowedDaysOfWeek: c.allowedDaysOfWeek,
    })
    return {
      timezone: c.timezone,
      confirmed,
      earliestHour: c.earliestHour,
      latestHour: c.latestHour,
      allowedDaysOfWeek: c.allowedDaysOfWeek,
      // An unconfirmed row is never "open", whatever the clock says.
      openNow: confirmed && win.allowed,
      closedReason: confirmed && !win.allowed ? (win.reason ?? null) : null,
      confirmedBy: c.policyConfirmedBy,
      confirmedAt: c.policyConfirmedAt,
    }
  })

  return {
    windows,
    unconfirmedTimezones: status.unconfirmedTimezones,
    defaultTimezone,
    vendors: [
      {
        name: 'DNC scrub',
        value: env.DNC_VENDOR ?? 'Not selected',
        configured: isDncVendorConfigured(env),
        note: 'Blocks numbers on federal and state Do Not Call registries.',
      },
      {
        name: 'Litigator scrub',
        value: env.LITIGATOR_VENDOR ?? 'Not selected',
        configured: isLitigatorVendorConfigured(env),
        note: 'Known TCPA litigator list (the "TCPA Shield" class of vendor).',
      },
      {
        name: 'Mobile line lookup',
        value: env.MOBILE_LINE_VENDOR,
        configured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
        note: 'Flags wireless numbers, which carry stricter consent rules.',
      },
    ],
  }
}

/* ------------------------------------------------------------------ usage -- */

export interface UsageInfo {
  spendUsd: number
  capUsd: number
  exceeded: boolean
  callsPlaced: number
  talkSeconds: number
  periodStart: Date
}

/**
 * Month-to-date usage. The window is B's UTC month boundary, reused verbatim.
 *
 * A local (America/New_York) month start would look friendlier but would put
 * the call count and the spend on DIFFERENT months for the last five hours of
 * every UTC month — and the spend figure is the one that actually halts the
 * dialer, so the panel follows it rather than the wall clock. See §13.8.
 */
export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export async function getUsageInfo(now = new Date()): Promise<UsageInfo> {
  const organizationId = await getCurrentOrgId()
  const periodStart = monthStartUtc(now)

  const [cap, agg] = await Promise.all([
    monthlyCapStatus(prisma),
    prisma.call.aggregate({
      where: { organizationId, activityAt: { gte: periodStart } },
      _count: { _all: true },
      _sum: { duration: true },
    }),
  ])

  return {
    spendUsd: cap.spendUsd,
    capUsd: cap.capUsd,
    exceeded: cap.exceeded,
    callsPlaced: agg._count._all,
    talkSeconds: agg._sum.duration ?? 0,
    periodStart,
  }
}
