import { Badge } from '@/components/ui'
import { SettingsCard, SettingsPanel } from '@/components/settings/SettingsPanel'
import { findSettingsSection } from '@/lib/settings/nav'
import { formatAddedDate, maskedPhone, type DoNotContactList } from '@/lib/settings/doNotContact'
import { OptOutForm } from './OptOutForm'

const SECTION = findSettingsSection('do-not-contact')!

/**
 * Brief 47 (PR 5): Settings → Do not contact, drawn on the server. `list` has
 * only the last 4 digits of each number (readDoNotContactList), so the full
 * number is in neither the HTML nor the page data [engineering precaution].
 * No remove button [engineering precaution]: removing an opt-out allows
 * contact again, so removing one stays a deliberate database job.
 */
export function DoNotContactView({ list }: { list: DoNotContactList }) {
  return (
    <SettingsPanel title={SECTION.label} blurb={SECTION.blurb}>
      <SettingsCard
        title="Add a number"
        footer="Type it any way: 212-555-0100, (212) 555-0100 or +1 212 555 0100. Adding a number that's already on the list changes nothing."
      >
        <div className="space-y-1 py-1 text-sm text-muted">
          <p>
            Add anyone who asks not to be contacted. This CRM won&rsquo;t call or text a number on
            this list. It&rsquo;s a list of phone numbers, so it doesn&rsquo;t cover email.
          </p>
          <p>A text reply of STOP adds the number by itself.</p>
        </div>
        <OptOutForm />
      </SettingsCard>

      <SettingsCard
        title="On the list"
        action={<Badge>{list.total.toLocaleString('en-US')}</Badge>}
        footer="There is no remove button. Taking a number off the list would allow calls and texts to it again, so that can't be done here."
      >
        {list.rows.length === 0 ? (
          <p className="py-1 text-sm text-subtle">No numbers on the list yet.</p>
        ) : (
          <table className="w-full text-sm" data-opt-out-list>
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-1.5 pr-3 font-medium">Number</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Reason</th>
                <th scope="col" className="py-1.5 text-right font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-fg">{maskedPhone(row.last4)}</td>
                  <td className="py-1.5 pr-3 text-fg">{row.reason ?? <span className="text-subtle">—</span>}</td>
                  <td className="whitespace-nowrap py-1.5 text-right text-muted">{formatAddedDate(row.addedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.capped && (
          <p className="py-1 text-xs text-subtle">
            Showing the newest {list.rows.length.toLocaleString('en-US')} of{' '}
            {list.total.toLocaleString('en-US')}.
          </p>
        )}
      </SettingsCard>
    </SettingsPanel>
  )
}
