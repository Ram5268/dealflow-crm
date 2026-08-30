import { findSettingsSection } from '@/lib/settings/nav'
import { NotSet, SettingsCard, SettingsPanel, SettingsRow } from '@/components/settings/SettingsPanel'
import { maskCallerId, pacingBandRows } from '@/lib/settings/format'

export const dynamic = 'force-dynamic'

const SECTION = findSettingsSection('calling')!

/**
 * Dialer configuration (M5 §6) — entirely read-only; every value here is an
 * env var consumed by Agent B at dial time, so an editable control would be a
 * lie until there is a settings store to write to.
 */
export default function CallingSettingsPage() {
  const callerId = process.env.TWILIO_CALLER_ID_NUMBER ?? ''
  const ringTimeout = process.env.RING_TIMEOUT_SECONDS ?? '19'
  const bands = pacingBandRows()

  return (
    <SettingsPanel title={SECTION.label} blurb={SECTION.blurb}>
      <SettingsCard title="Outbound" footer="Configured in .env.">
        <dl>
          <SettingsRow
            label="Caller ID"
            hint="Env-configured"
            value={callerId ? maskCallerId(callerId) : <NotSet>Not provisioned</NotSet>}
            caption={
              callerId
                ? 'The number recipients see. TWILIO_CALLER_ID_NUMBER.'
                : 'No Twilio number yet — outbound calling is unavailable until one is provisioned.'
            }
          />
          <SettingsRow
            label="Ring timeout"
            hint="Env-configured"
            value={`${ringTimeout}s`}
            caption="How long a line rings before the dialer gives up. RING_TIMEOUT_SECONDS."
          />
        </dl>
      </SettingsCard>

      <SettingsCard
        title="Pacing bands"
        footer="The dialer re-evaluates its line count against the rolling 30-day abandonment rate. Bands are fixed in code, not configurable."
      >
        <p className="pb-2 text-xs text-muted">
          FTC rule 16 CFR 310.4(b)(4) caps abandoned calls at 3%. The control law stays under it by
          shedding lines as the rate climbs, and halting before the cap.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-1 pr-3 font-medium">Band</th>
                <th scope="col" className="py-1 pr-3 font-medium">Abandonment</th>
                <th scope="col" className="py-1 pr-3 font-medium">Action</th>
                <th scope="col" className="py-1 font-medium">New lines</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.band} className="border-b border-line last:border-0">
                  <td className="py-1 pr-3 text-muted">{b.band}</td>
                  <td className="py-1 pr-3 tabular-nums text-fg">{b.range}</td>
                  <td className="py-1 pr-3 text-fg">{b.action}</td>
                  <td className="py-1 tabular-nums text-muted">{b.lines}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </SettingsPanel>
  )
}
