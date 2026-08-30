'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Select, Textarea, useToast } from '@/components/ui'
import type { SequenceDetail } from '@/lib/sequences/queries'
import type { TemplateRow } from '@/lib/sequences/queries'

export interface DraftStep {
  channel: 'email' | 'sms'
  delayHours: number
  templateId: string
}

/**
 * Create/edit a sequence. One form for both — D's POST and PATCH take the same
 * `sequenceInputSchema`, and PATCH reconciles steps positionally so surviving
 * ids stay resolvable for in-flight enrollments.
 *
 * Step types are `email | sms` ONLY. There is no condition/branch step: D's
 * `stepInputSchema` does not model one and the tick worker could not run it.
 *
 * `templateId` is REQUIRED on every step (`z.string()`, not optional), so a step
 * cannot carry inline subject/body — it always points at a saved template. That
 * is why this editor refuses to render the step form until a template exists.
 */
export function SequenceEditor({
  sequence,
  templates,
}: {
  sequence: SequenceDetail | null
  templates: TemplateRow[]
}) {
  const router = useRouter()
  const { toast } = useToast()

  const [name, setName] = useState(sequence?.name ?? '')
  const [description, setDescription] = useState(sequence?.description ?? '')
  const [steps, setSteps] = useState<DraftStep[]>(
    sequence?.steps.map((s) => ({
      channel: s.channel === 'sms' ? 'sms' : 'email',
      delayHours: s.delayHours,
      templateId: s.templateId,
    })) ?? [],
  )
  const [saving, setSaving] = useState(false)

  const templateOptions = templates.map((t) => ({ value: t.id, label: `${t.name} (${t.channel})` }))

  const addStep = useCallback(() => {
    setSteps((cur) => [
      ...cur,
      // First step fires immediately; later ones default to a day apart.
      { channel: 'email', delayHours: cur.length === 0 ? 0 : 24, templateId: templates[0]?.id ?? '' },
    ])
  }, [templates])

  const patchStep = useCallback((i: number, patch: Partial<DraftStep>) => {
    setSteps((cur) => cur.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }, [])

  const removeStep = useCallback((i: number) => {
    setSteps((cur) => cur.filter((_, idx) => idx !== i))
  }, [])

  const move = useCallback((i: number, delta: number) => {
    setSteps((cur) => {
      const j = i + delta
      if (j < 0 || j >= cur.length) return cur
      const next = [...cur]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }, [])

  /** email + sms mixed → 'mixed', matching D's sequence channel enum. */
  const derivedChannel = useCallback((): 'email' | 'sms' | 'mixed' => {
    if (steps.length === 0) return 'email'
    const set = new Set(steps.map((s) => s.channel))
    if (set.size > 1) return 'mixed'
    return steps[0].channel
  }, [steps])

  const save = useCallback(async () => {
    if (!name.trim()) {
      toast({ tone: 'danger', title: 'Name is required' })
      return
    }
    if (steps.some((s) => !s.templateId)) {
      toast({ tone: 'danger', title: 'Every step needs a template' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        channel: derivedChannel(),
        steps: steps.map((s, i) => ({
          ordinal: i,
          delayHours: s.delayHours,
          channel: s.channel,
          templateId: s.templateId,
        })),
      }
      const res = await fetch(
        sequence ? `/api/comms/sequences/${sequence.id}` : '/api/comms/sequences',
        {
          method: sequence ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (res.status === 409) {
        // D refuses to drop a step an active enrollment is currently sitting on.
        toast({
          tone: 'danger',
          title: 'Step still in use',
          description: 'An active enrollment is on a step you removed. Unenroll it first.',
        })
        return
      }
      if (!res.ok) {
        toast({ tone: 'danger', title: 'Could not save sequence' })
        return
      }
      const saved = await res.json()
      toast({ tone: 'success', title: sequence ? 'Sequence updated' : 'Sequence created' })
      router.push(`/sequences/${saved.id ?? sequence?.id}`)
      router.refresh()
    } catch {
      toast({ tone: 'danger', title: 'Could not save sequence' })
    } finally {
      setSaving(false)
    }
  }, [name, description, steps, derivedChannel, sequence, router, toast])

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="flex-1 text-sm font-semibold text-fg">
          {sequence ? 'Edit sequence' : 'New sequence'}
        </h1>
        <Button asChild variant="secondary" size="sm">
          <Link href={sequence ? `/sequences/${sequence.id}` : '/sequences'}>Cancel</Link>
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={saving}>
          Save
        </Button>
      </div>

      <div className="mb-4 flex flex-col gap-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Textarea
          label="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted">Steps</h2>
        {templates.length > 0 && (
          <Button variant="secondary" size="sm" onClick={addStep}>
            <Plus size={13} />
            Add step
          </Button>
        )}
      </div>

      {templates.length === 0 ? (
        <EmptyState
          title="Create a template first."
          description="Every sequence step sends a saved template, so there is nothing to add yet."
          action={
            <Button asChild variant="primary" size="sm">
              <Link href="/templates/new">New template</Link>
            </Button>
          }
        />
      ) : steps.length === 0 ? (
        <EmptyState title="No steps yet." description="Add the first step to get started." />
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((s, i) => (
            <li key={i} className="rounded-lg border border-line bg-elevated p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="neutral">Step {i + 1}</Badge>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Move down"
                  disabled={i === steps.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown size={13} />
                </Button>
                <Button size="sm" variant="ghost" aria-label="Remove step" onClick={() => removeStep(i)}>
                  <Trash2 size={13} />
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <Select
                  label="Type"
                  value={s.channel}
                  onValueChange={(v) => patchStep(i, { channel: v as 'email' | 'sms' })}
                  options={[
                    { value: 'email', label: 'Email' },
                    { value: 'sms', label: 'SMS' },
                  ]}
                />
                <Input
                  label="Delay (hours)"
                  type="number"
                  min={0}
                  value={String(s.delayHours)}
                  onChange={(e) => patchStep(i, { delayHours: Math.max(0, Number(e.target.value) || 0) })}
                />
                <Select
                  label="Template"
                  value={s.templateId || undefined}
                  onValueChange={(v) => patchStep(i, { templateId: v })}
                  options={templateOptions}
                  placeholder="Choose…"
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
