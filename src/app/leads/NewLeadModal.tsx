'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Button, Field, Input, Modal, useToast } from '@/components/ui'

/**
 * Create-lead form, opened by `?new=1` (M6).
 *
 * Both the top bar's "New Lead" item and the ⌘K action already pointed here,
 * but /leads ignored the parameter — so two visible affordances did nothing.
 * `POST /api/leads` existed all along; only the surface was missing.
 *
 * Deliberately minimal: displayName is the only required column, and everything
 * else about a lead is better captured by the CSV importer than by retyping it.
 */
export function NewLeadModal() {
  const router = useRouter()
  const params = useSearchParams()
  const { toast } = useToast()
  const open = params.get('new') === '1'

  const [displayName, setDisplayName] = useState('')
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)

  function close() {
    setDisplayName('')
    setAddress('')
    // Drop only `new`, so a filtered/sorted list is not reset by closing.
    const next = new URLSearchParams(params.toString())
    next.delete('new')
    router.push(next.size ? `/leads?${next}` : '/leads')
  }

  async function submit() {
    const name = displayName.trim()
    if (!name) return
    setSaving(true)
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: name,
          primaryAddressFull: address.trim() || undefined,
          source: 'manual',
        }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        toast({
          tone: 'danger',
          title: 'Could not create lead',
          description: detail?.error ?? `Request failed (${res.status}).`,
        })
        return
      }
      const { lead } = await res.json()
      toast({ tone: 'success', title: `${name} created` })
      router.push(`/leads/${lead.id}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
      }}
      title="New lead"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={saving}
            disabled={!displayName.trim()}
          >
            Create lead
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" htmlFor="new-lead-name">
          <Input
            id="new-lead-name"
            autoFocus
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Owner name or LLC"
          />
        </Field>
        <Field label="Address" htmlFor="new-lead-address" hint="Optional.">
          <Input
            id="new-lead-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="412 W 22nd St, New York, NY"
          />
        </Field>
      </div>
    </Modal>
  )
}
