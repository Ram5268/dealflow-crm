'use client'

import { useCallback, useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import {
  Button,
  Drawer,
  Input,
  Select,
  Textarea,
  useToast,
  type SelectOption,
} from '@/components/ui'

interface TemplateRow {
  id: string
  name: string
  subject: string | null
  bodyText: string
}

/** Very small: one address, no display name, no folding. Enough to reject a
 *  typo before a send attempt, not a full RFC 5322 parser. */
export function isValidEmail(value: string): boolean {
  const v = value.trim()
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v)
}

/**
 * Standalone email composer (M6), opened by `/inbox?compose=1` and by the ⌘K
 * "Compose email" action.
 *
 * The reply drawer is thread-scoped and cannot start a conversation — it reads
 * its recipient off the thread being answered. Agent D's `POST
 * /api/comms/messages` accepts a threadless email, so composing needed a
 * surface, not a new route.
 *
 * Email only. SMS is switched off pending 10DLC registration, so offering a
 * channel picker here would only ever offer one working option.
 */
export function ComposeDrawer({
  open,
  onOpenChange,
  onSent,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onSent: () => void
}) {
  const { toast } = useToast()
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [templateId, setTemplateId] = useState<string | undefined>(undefined)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    setTo('')
    setSubject('')
    setBody('')
    setTemplateId(undefined)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/comms/templates?channel=email')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.templates) setTemplates(d.templates)
      })
      .catch(() => {
        /* the composer works fine without templates */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id)
      const t = templates.find((x) => x.id === id)
      if (!t) return
      if (t.subject) setSubject(t.subject)
      setBody(t.bodyText)
    },
    [templates],
  )

  const recipientValid = isValidEmail(to)

  const send = useCallback(async () => {
    if (!recipientValid || body.trim().length === 0) return
    setSending(true)
    try {
      const res = await fetch('/api/comms/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'email',
          // No threadId: this STARTS a thread rather than joining one.
          toAddresses: [to.trim()],
          subject,
          bodyText: body,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.status === 'error') {
        toast({ tone: 'danger', title: 'Send failed', description: 'The message was not sent.' })
        return
      }
      toast({ tone: 'success', title: 'Sent', description: to.trim() })
      onSent()
    } catch {
      toast({ tone: 'danger', title: 'Send failed', description: 'The message was not sent.' })
    } finally {
      setSending(false)
    }
  }, [recipientValid, to, subject, body, toast, onSent])

  const templateOptions: SelectOption[] = templates.map((t) => ({ value: t.id, label: t.name }))

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="New email"
      footer={
        <>
          {templateOptions.length > 0 && (
            <Select
              value={templateId}
              onValueChange={applyTemplate}
              options={templateOptions}
              placeholder="Template…"
              className="mr-auto w-44"
            />
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={send}
            loading={sending}
            disabled={!recipientValid || body.trim().length === 0}
          >
            <Send size={13} />
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="To"
          autoFocus
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="name@example.com"
          // Only complain once something has been typed — an empty composer is
          // not an error, it is the starting state.
          error={to.length > 0 && !recipientValid ? 'Enter a valid email address.' : undefined}
        />
        <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Textarea
          label="Message"
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message…"
        />
      </div>
    </Drawer>
  )
}
