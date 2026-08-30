import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { getComplianceInfo } from '@/lib/settings/queries'
import { findSettingsSection } from '@/lib/settings/nav'
import { SettingsCard, SettingsPanel, SettingsRow } from '@/components/settings/SettingsPanel'
import { Badge } from '@/components/ui'
import { formatAllowedDays, formatWindow } from '@/lib/settings/format'

export const dynamic = 'force-dynamic'

const SECTION = findSettingsSection('compliance')!

const CLOSED_REASON_TEXT: Record<string, string> = {
  outside_calling_window_hour: 'outside the permitted hours right now',
  outside_calling_window_day: 'not a permitted day',
  timezone_invalid: 'the configured timezone is not a valid IANA zone',
}

/**
 * Pure display (M5 §7) — nothing on this page toggles anything. Suppression
 * vendors are env-selected and the calling policy is confirmed through Agent
 * C's own confirm route after Ryan talks to counsel, so a checkbox here would
 * be a control that silently does nothing.
 */
export default async function ComplianceSettingsPage() {
  const info = await getComplianceInfo()
  const nothingConfirmed = info.windows.every((w) => !w.confirmed)

  return (
    <SettingsPanel title={SECTION.label} blurb={SECTION.blurb}>
      <SettingsCard
        title="Calling window"
        footer="Windows are per timezone and must be confirmed with counsel before any number in that timezone can be dialed."
      >
        {info.windows.length === 0 || nothingConfirmed ? (
          // The honest state today: C's gate rejects EVERY number in a timezone
          // with no confirmed CallingWindowConfig, so this must not print hours.
          <div className="flex gap-2 py-1">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 text-xs">
              <p className="font-medium text-fg">No calling policy is confirmed — calls are blocked.</p>
              <p className="mt-1 text-muted">
                Every number is rejected with <code className="text-fg">policy_unconfirmed</code>{' '}
                until a calling window is confirmed for its timezone
                {info.windows.length === 0 ? '' : ', including the windows configured below'}. This
                is not bypassed in development.
              </p>
              {info.unconfirmedTimezones.length > 0 && (
                <p className="mt-1 text-muted">
                  Timezones on your contacts awaiting confirmation:{' '}
                  <span className="text-fg">{info.unconfirmedTimezones.join(', ')}</span>
                </p>
              )}
              {info.windows.length === 0 && (
                <p className="mt-1 text-subtle">
                  No window is configured for any timezone (your default is {info.defaultTimezone}).
                </p>
              )}
            </div>
          </div>
        ) : (
          <dl>
            {info.windows.map((w) => (
              <SettingsRow
                key={w.timezone}
                label={w.timezone}
                value={
                  <span className="flex items-center gap-1.5">
                    {w.openNow ? (
                      <CheckCircle2 aria-hidden className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <XCircle aria-hidden className="h-3.5 w-3.5 text-subtle" />
                    )}
                    <span>
                      {formatWindow(w.earliestHour!, w.latestHour!)},{' '}
                      {formatAllowedDays(w.allowedDaysOfWeek)}
                    </span>
                  </span>
                }
                caption={
                  !w.confirmed
                    ? 'Not confirmed — calls in this timezone are blocked.'
                    : w.openNow
                      ? 'Open right now.'
                      : `Closed right now — ${CLOSED_REASON_TEXT[w.closedReason ?? ''] ?? 'outside the window'}.`
                }
              />
            ))}
          </dl>
        )}
      </SettingsCard>

      <SettingsCard
        title="Suppression vendors"
        footer="Selected in .env. With no vendor keyed, the scrub client fails closed — numbers are blocked rather than passed."
      >
        <dl>
          {info.vendors.map((v) => (
            <SettingsRow
              key={v.name}
              label={v.name}
              hint="Env-configured"
              value={
                <span className="flex items-center gap-2">
                  <span className={v.configured ? 'text-fg' : 'text-subtle'}>{v.value}</span>
                  <Badge tone={v.configured ? 'success' : 'neutral'}>
                    {v.configured ? 'Active' : 'Not configured'}
                  </Badge>
                </span>
              }
              caption={v.note}
            />
          ))}
        </dl>
      </SettingsCard>
    </SettingsPanel>
  )
}
