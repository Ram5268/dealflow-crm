'use client'

import { useCallback, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Zap } from 'lucide-react'
import { Button, Modal, Select, useToast } from '@/components/ui'

export interface EnrollableSequence {
  id: string
  name: string
  stepCount: number
}

export interface EnrollableContact {
  id: string
  displayName: string
}

/**
 * "Add to sequence" on the lead header.
 *
 * Enrollment keys on CONTACT, not lead — `SequenceEnrollment.contactId`, and D's
 * `enrollContact` looks the contact up directly. The M4 brief said "enrolls the
 * lead"; a lead can own several contacts, so the picker asks which one whenever
 * that is ambiguous rather than silently picking the first.
 *
 * The brief also named `POST /api/comms/sequences/[id]/enroll`. That route does
 * not exist; the real one is `POST /api/comms/enrollments`.
 *
 * Brief 41.2 (PR E): with `disabledReason` (email and texting both off) the
 * button is greyed out with that one-line reason beside it. Greyed out with the
 * reason, not hidden, is Ryan's decision of 2026-10-17. The route refuses the
 * enrollment anyway (engineering precaution, audit H15), and with one switch on
 * it refuses a sequence that needs the other; the toast shows its reason.
 */
export function EnrollButton({
  sequences,
  contacts,
  disabledReason,
}: {
  sequences: EnrollableSequence[]
  contacts: EnrollableContact[]
  disabledReason?: string | null
}) {
  const router = useRouter()
  const { toast } = useToast()
  const reasonId = useId()
  const [open, setOpen] = useState(false)
  const [sequenceId, setSequenceId] = useState<string | undefined>(undefined)
  const [contactId, setContactId] = useState<string | undefined>(contacts[0]?.id)
  const [busy, setBusy] = useState(false)

  const enroll = useCallback(async () => {
    if (!sequenceId || !contactId) return
    setBusy(true)
    try {
      const res = await fetch('/api/comms/enrollments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequenceId, contactId }),
      })
      if (res.status === 409) {
        toast({ title: 'Already enrolled', description: 'This contact is already in that sequence.' })
        setOpen(false)
        return
      }
      if (res.status === 403) {
        // A channel this sequence uses is off; nothing was saved.
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        toast({ tone: 'danger', title: 'Could not enroll', description: body?.message })
        return
      }
      if (!res.ok) {
        toast({ tone: 'danger', title: 'Could not enroll' })
        return
      }
      toast({ tone: 'success', title: 'Enrolled' })
      setOpen(false)
      router.refresh()
    } catch {
      toast({ tone: 'danger', title: 'Could not enroll' })
    } finally {
      setBusy(false)
    }
  }, [sequenceId, contactId, router, toast])

  const noContacts = contacts.length === 0
  const noSequences = sequences.length === 0

  if (disabledReason) {
    return (
      <span className="flex items-center gap-2">
        <Button disabled aria-describedby={reasonId}>
          <Zap size={13} />
          Add to sequence
        </Button>
        <span id={reasonId} className="text-xs text-muted">
          {disabledReason}
        </span>
      </span>
    )
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Zap size={13} />
        Add to sequence
      </Button>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add to sequence"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={enroll}
              loading={busy}
              disabled={!sequenceId || !contactId}
            >
              Enroll
            </Button>
          </>
        }
      >
        {noContacts ? (
          <p className="text-sm text-muted">
            This lead has no contacts. Enrollment targets a contact, so add one first.
          </p>
        ) : noSequences ? (
          <p className="text-sm text-muted">
            No sequences yet.{' '}
            <Link href="/sequences/new" className="text-accent hover:underline">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Select
              label="Sequence"
              value={sequenceId}
              onValueChange={setSequenceId}
              options={sequences.map((s) => ({
                value: s.id,
                label: `${s.name} · ${s.stepCount} step${s.stepCount === 1 ? '' : 's'}`,
              }))}
              placeholder="Choose a sequence…"
            />
            {/* Only ask when it is genuinely ambiguous. */}
            {contacts.length > 1 && (
              <Select
                label="Contact"
                value={contactId}
                onValueChange={setContactId}
                options={contacts.map((c) => ({ value: c.id, label: c.displayName }))}
              />
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
