'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Button, useToast } from '@/components/ui'
import { SettingsCard, SettingsRow, NotSet } from '@/components/settings/SettingsPanel'
import { shortStamp } from '@/lib/ui/time'
import type { MailboxCardActions } from '@/lib/settings/format'

// Brief 41.2: pausedNote / connect / disconnect are decided on the server
// (mailboxCardActions), so a paused Outlook card gets no Connect link at all.
export interface MailboxCardAccount extends MailboxCardActions {
  key: 'gmail' | 'outlook'
  label: string
  connected: boolean
  emailAddress: string | null
  status: string | null
  updatedAt: string | null
  hasSyncCursor: boolean
  remoteRevocation: boolean
}

export function MailboxCard({ account }: { account: MailboxCardAccount }) {
  const router = useRouter()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  async function disconnect() {
    setBusy(true)
    try {
      const res = await fetch(`/api/oauth/${account.key}/revoke`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // The route leaves the credential untouched when the provider rejects
        // revocation, so the card must keep saying "connected" — surface why
        // rather than optimistically flipping it.
        toast({
          tone: 'danger',
          title: 'Could not disconnect',
          description:
            body?.error === 'provider_revocation_failed'
              ? `${account.label} rejected the revocation. The account is still connected.`
              : (body?.error ?? `Request failed (${res.status}).`),
        })
        return
      }
      toast({
        tone: 'success',
        title: `${account.label} disconnected`,
        description: body?.remoteRevocation
          ? 'The token was revoked with the provider.'
          : 'The local connection was removed.',
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title={account.label}
      action={
        account.connected ? (
          <Badge tone={account.status === 'active' ? 'success' : 'warning'}>
            {account.status === 'active' ? 'Connected' : (account.status ?? 'Connected')}
          </Badge>
        ) : (
          <Badge tone="neutral">Not connected</Badge>
        )
      }
      footer={
        account.connected && !account.remoteRevocation
          ? 'Removes the local connection; sign out of Microsoft separately for full revocation.'
          : undefined
      }
    >
      <dl>
        <SettingsRow
          label="Account"
          value={account.emailAddress ?? <NotSet>Not connected</NotSet>}
        />
        <SettingsRow
          label="Last updated"
          value={account.updatedAt ? shortStamp(new Date(account.updatedAt)) : <NotSet>—</NotSet>}
          // Nothing records a mailbox sync time, so this is the credential row's
          // own mtime — a token refresh moves it too. Labelled for what it is
          // rather than dressed up as "Last sync". See §13.4.
          caption={
            account.connected
              ? account.hasSyncCursor
                ? 'Credential record changed (token refresh or sync cursor). Sync has run at least once.'
                : 'Credential record changed. No sync has run yet.'
              : undefined
          }
        />
      </dl>

      {account.pausedNote ? (
        <p role="status" className="mt-2 rounded-md bg-warning-subtle px-2 py-1.5 text-sm text-warning">
          {account.pausedNote}
        </p>
      ) : null}

      {account.disconnect || account.connect ? (
        <div className="mt-2 flex gap-2">
          {account.disconnect ? (
            <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          ) : null}
          {/* A plain link, not fetch: the authorize route 302s to the provider's
              consent screen, which cannot be followed from XHR. */}
          {account.connect ? (
            <Button asChild variant={account.connected ? 'ghost' : 'primary'} size="sm">
              <a href={account.connect.href}>{account.connect.label}</a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  )
}
