'use client'

import { useState } from 'react'
import { SquareKanban } from 'lucide-react'
import { Button, EmptyState, Input } from '@/components/ui'
import { NAME_MAX } from '@/lib/core-data/lists/types'
import { createGroupNamed, problemText } from './api'

/**
 * No groups yet [brief §5.6]. "+ Group" creates one right here: type a name,
 * Enter (Esc cancels). The CRM starts with no groups; Ryan makes every one
 * [Ryan, 2026-10-18].
 */
export function EmptyPipeline({ onCreated }: { onCreated: () => void }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cancel = () => {
    setCreating(false)
    setName('')
    setError(null)
  }

  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await createGroupNamed(name.trim())
      cancel()
      onCreated()
    } catch (err) {
      setError(problemText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <EmptyState
      icon={<SquareKanban />}
      title="Create a group to start your pipeline"
      description="Groups are labels like Hot, Nurture or Appointment Set. Each group becomes a column here. Put people in a group from their contact card, then move them between columns as things change."
      action={
        creating ? (
          <form
            className="flex w-[min(22rem,calc(100vw-3rem))] flex-col gap-2 text-left"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <Input
              aria-label="Group name"
              placeholder="e.g. Hot"
              value={name}
              maxLength={NAME_MAX}
              autoFocus
              error={error ?? undefined}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  cancel()
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!name.trim()}>
                Create group
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="primary" onClick={() => setCreating(true)}>
            + Group
          </Button>
        )
      }
    />
  )
}
