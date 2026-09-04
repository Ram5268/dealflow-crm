import { getUsageInfo } from '@/lib/settings/queries'
import { findSettingsSection } from '@/lib/settings/nav'
import { SettingsCard, SettingsPanel, SettingsRow } from '@/components/settings/SettingsPanel'
import { cn } from '@/lib/ui/cn'
import { formatMinutes, formatUsd, spendPercent, spendTone } from '@/lib/settings/format'

export const dynamic = 'force-dynamic'

const SECTION = findSettingsSection('usage')!

const BAR_TONE = {
  ok: 'bg-accent',
  warn: 'bg-warning',
  danger: 'bg-danger',
} as const

const TEXT_TONE = {
  ok: 'text-fg',
  warn: 'text-warning',
  danger: 'text-danger',
} as const

export default async function UsageSettingsPage() {
  const usage = await getUsageInfo()
  const tone = spendTone(usage.spendUsd, usage.capUsd)
  const percent = spendPercent(usage.spendUsd, usage.capUsd)
  const period = usage.periodStart.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <SettingsPanel title={SECTION.label} blurb={SECTION.blurb}>
      <SettingsCard
        title={`Telephony spend — ${period}`}
        footer="Spend is summed from the outbound leg of each call. The cap is a soft limit: the dialer halts at 100%, it does not stop calls already connected."
      >
        <div className="py-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn('text-2xl font-semibold tabular-nums', TEXT_TONE[tone])}>
              {formatUsd(usage.spendUsd)}
            </span>
            <span className="text-xs text-muted">
              of {formatUsd(usage.capUsd)} cap
            </span>
          </div>

          <div
            role="progressbar"
            aria-label="Month-to-date telephony spend against cap"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${formatUsd(usage.spendUsd)} of ${formatUsd(usage.capUsd)}`}
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-hover"
          >
            <div
              className={cn('h-full rounded-full transition-[width]', BAR_TONE[tone])}
              style={{ width: `${percent}%` }}
            />
          </div>

          {usage.exceeded && (
            <p className="mt-2 text-xs text-danger">
              Cap reached — the dialer is halted until the cap resets or is raised.
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Activity"
        footer={
          usage.callsPlaced === 0
            ? 'No calls placed yet, so these are true zeros rather than a stub.'
            : undefined
        }
      >
        <dl>
          <SettingsRow
            label="Calls placed"
            value={<span className="tabular-nums">{usage.callsPlaced}</span>}
            caption="Every call record this month, inbound and outbound."
          />
          <SettingsRow
            label="Minutes used"
            value={<span className="tabular-nums">{formatMinutes(usage.talkSeconds)}</span>}
            caption="Connected talk time. Ring time is not billed as duration."
          />
          <SettingsRow
            label="Spend cap"
            hint="Env-configured"
            value={<span className="tabular-nums">{formatUsd(usage.capUsd)}</span>}
            caption="TWILIO_MONTHLY_SPEND_CAP_USD."
          />
        </dl>
      </SettingsCard>

      {/* The window is Agent B's UTC month boundary, reused so the spend figure
          and the counts beside it can never describe different months. */}
      <p className="text-xs text-subtle">
        Counted from {usage.periodStart.toISOString().slice(0, 10)} (UTC), matching the boundary the
        dialer&rsquo;s spend cap resets on.
      </p>
    </SettingsPanel>
  )
}
