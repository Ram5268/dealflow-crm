import { getMailboxAccounts } from '@/lib/settings/queries'
import { findSettingsSection } from '@/lib/settings/nav'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { MailboxCard } from './MailboxCard'

export const dynamic = 'force-dynamic'

const SECTION = findSettingsSection('connected-accounts')!

/**
 * Two provider cards (M5 §5). Close shows a generic account list behind one
 * "Add Account" button because it supports many accounts across many
 * providers; we support exactly two, so a card each is clearer. See §13.3.
 *
 * Reads only — OAuthCredential is never written from this surface.
 */
export default async function ConnectedAccountsPage() {
  const accounts = await getMailboxAccounts()

  return (
    <SettingsPanel title={SECTION.label} blurb={SECTION.blurb}>
      {accounts.map((account) => (
        <MailboxCard key={account.key} account={{ ...account, updatedAt: account.updatedAt?.toISOString() ?? null }} />
      ))}
      <p className="text-[11px] text-subtle">
        DealFlow reads mail through these accounts and sends replies as them. Disconnecting stops
        both.
      </p>
    </SettingsPanel>
  )
}
