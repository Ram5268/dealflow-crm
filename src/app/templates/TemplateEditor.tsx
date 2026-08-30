'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import {
  Button,
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownTrigger,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { renderTemplate } from '@/lib/comms/templates/render'
import { MERGE_TAGS, SAMPLE_SOURCES, insertAtCursor } from '@/lib/templates/mergeTags'
import type { TemplateRow } from '@/lib/sequences/queries'

/**
 * Create/edit a MessageTemplate. One form for both, because the fields are
 * identical and D's POST/PATCH take the same shape.
 *
 * Body is plain text, not rich text: `MessageTemplate.bodyText` is what every
 * consumer reads (sequence steps, the inbox composer), `bodyHtml` is optional
 * and unused by this build, and a rich-text editor would mean either a new
 * dependency or hand-rolled contenteditable — neither justified for a field
 * whose merge tags are typed inline anyway.
 */
export function TemplateEditor({ template }: { template: TemplateRow | null }) {
  const router = useRouter()
  const { toast } = useToast()
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const [name, setName] = useState(template?.name ?? '')
  const [channel, setChannel] = useState(template?.channel ?? 'email')
  const [subject, setSubject] = useState(template?.subject ?? '')
  const [body, setBody] = useState(template?.bodyText ?? '')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const isEmail = channel === 'email'

  const insertTag = useCallback((token: string) => {
    const el = bodyRef.current
    setBody((current) => {
      const start = el?.selectionStart ?? current.length
      const end = el?.selectionEnd ?? current.length
      const next = insertAtCursor(current, token, start, end)
      // Restore the caret after React commits, so typing continues in place.
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(next.cursor, next.cursor)
      })
      return next.value
    })
  }, [])

  const preview = useMemo(
    () => ({
      subject: renderTemplate(subject, SAMPLE_SOURCES),
      body: renderTemplate(body, SAMPLE_SOURCES),
    }),
    [subject, body],
  )

  const save = useCallback(async () => {
    if (!name.trim() || !body.trim()) {
      toast({ tone: 'danger', title: 'Name and body are required' })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        channel,
        // SMS has no subject; sending one would fail D's validation intent.
        subject: isEmail ? subject || null : null,
        bodyText: body,
      }
      const res = await fetch(
        template ? `/api/comms/templates/${template.id}` : '/api/comms/templates',
        {
          method: template ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) {
        toast({ tone: 'danger', title: 'Could not save template' })
        return
      }
      const saved = await res.json()
      toast({ tone: 'success', title: template ? 'Template updated' : 'Template created' })
      router.push(`/templates/${saved.id ?? template?.id}`)
      router.refresh()
    } catch {
      toast({ tone: 'danger', title: 'Could not save template' })
    } finally {
      setSaving(false)
    }
  }, [name, channel, subject, body, isEmail, template, router, toast])

  const remove = useCallback(async () => {
    if (!template) return
    try {
      const res = await fetch(`/api/comms/templates/${template.id}`, { method: 'DELETE' })
      if (res.status === 409) {
        // D refuses to delete a template a sequence step still points at.
        toast({
          tone: 'danger',
          title: 'Template is in use',
          description: 'A sequence step still uses this template.',
        })
        return
      }
      if (!res.ok) {
        toast({ tone: 'danger', title: 'Could not delete template' })
        return
      }
      toast({ title: 'Template deleted' })
      router.push('/templates')
      router.refresh()
    } finally {
      setConfirmDelete(false)
    }
  }, [template, router, toast])

  return (
    <div className="mx-auto max-w-5xl px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="flex-1 text-sm font-semibold text-fg">
          {template ? 'Edit template' : 'New template'}
        </h1>
        {template && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} />
            Delete
          </Button>
        )}
        <Button asChild variant="secondary" size="sm">
          <Link href="/templates">Cancel</Link>
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={saving}>
          Save
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select
            label="Channel"
            value={channel}
            onValueChange={setChannel}
            options={[
              { value: 'email', label: 'Email' },
              { value: 'sms', label: 'SMS' },
            ]}
          />
          {isEmail && (
            <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">Body</span>
              <DropdownRoot>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="sm">
                    Insert merge tag
                  </Button>
                </DropdownTrigger>
                <DropdownContent>
                  {MERGE_TAGS.map((t) => (
                    <DropdownItem key={t.token} onSelect={() => insertTag(t.token)}>
                      <span className="flex flex-col">
                        <span>{t.label}</span>
                        <span className="font-mono text-[10px] text-subtle">{t.token}</span>
                      </span>
                    </DropdownItem>
                  ))}
                </DropdownContent>
              </DropdownRoot>
            </div>
            <Textarea
              ref={bodyRef}
              rows={14}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi {{contact.firstName}} — …"
              aria-label="Body"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Preview</span>
          <div className="min-h-[300px] rounded-md border border-line bg-elevated p-3">
            {isEmail && (
              <p className="mb-2 border-b border-line pb-2 text-sm font-medium text-fg">
                {preview.subject || <span className="text-subtle">No subject</span>}
              </p>
            )}
            <p className="whitespace-pre-wrap break-words text-sm text-fg">
              {preview.body || <span className="text-subtle">Nothing to preview yet.</span>}
            </p>
          </div>
          <p className="text-xs text-subtle">
            Rendered with sample values. Unknown tags resolve to an empty string, never the
            literal <code className="font-mono">{'{{tag}}'}</code>.
          </p>
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete template?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {template?.name} will be removed. A template still used by a sequence step cannot be
          deleted.
        </p>
      </Modal>
    </div>
  )
}
