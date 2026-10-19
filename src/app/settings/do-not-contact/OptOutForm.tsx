'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button, Input } from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { submitOptOut, type OptOutOutcome } from '@/lib/settings/doNotContact'

/**
 * Brief 47 (PR 5): add one opt-out. Posts to the existing
 * `POST /api/compliance/dnc/internal` (submitOptOut) and, once the number is
 * on the list, refreshes the page so the list below shows it. Takes no props:
 * nothing about the list reaches the browser except what the page draws.
 */
export function OptOutForm() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<OptOutOutcome | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const result = await submitOptOut({ phone, reason })
      setOutcome(result)
      if (result.kind === 'added' || result.kind === 'already') {
        setPhone('')
        setReason('')
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const refused = outcome?.kind === 'invalid' || outcome?.kind === 'empty'

  return (
    <form onSubmit={onSubmit} noValidate data-opt-out-form className="space-y-2 py-1">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="212-555-0100"
          required
          value={phone}
          aria-invalid={refused || undefined}
          onChange={(e) => {
            setPhone(e.target.value)
            setOutcome(null)
          }}
        />
        <Input
          label="Reason (optional)"
          name="reason"
          autoComplete="off"
          maxLength={200}
          placeholder="Asked not to be called"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          Add to the list
        </Button>
        <OptOutOutcomeLine outcome={outcome} />
      </div>
    </form>
  )
}

/** The one line under the form after a submit: success or why it didn't work. */
export function OptOutOutcomeLine({ outcome }: { outcome: OptOutOutcome | null }) {
  if (!outcome) return null
  const ok = outcome.kind === 'added' || outcome.kind === 'already'
  return (
    <p
      role={ok ? 'status' : 'alert'}
      data-outcome={outcome.kind}
      className={cn('text-sm', ok ? 'text-success' : 'text-danger')}
    >
      {outcome.message}
    </p>
  )
}
