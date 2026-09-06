'use client'

import { useCallback, useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import {
  Button,
  Drawer,
  Input,
  Select,
  Textarea,
  Tooltip,
  useToast,
  type SelectOption,
} from '@/components/ui'
import type { ThreadDetail } from '@/lib/inbox/types'

/** Copy shown wherever SMS sending is offered but switched off. */
export const SMS_DISABLED_REASON = 'SMS pending 10DLC registration.'

interface TemplateRow {
  id: string
  name: string
  subject: string | null
  bodyText: string
}

/**
 * Reply composer. Reuses the non-modal `Drawer` primitive, so the thread stays
 * readable behind it while you write — the whole point of replying in place.
 *
 * Sending goes through Agent D's existing `POST /api/comms/messages`. Agent E
 * owns none of the send path; it supplies the payload and renders the outcome.
 */
export function ReplyDrawer({
  open,
  onOpenChange,
  detail,
  onSent,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  detail: ThreadDetail | null
  onSent: () => void
}) {
  const { toast } = useToast()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [templateId, setTemplateId] = useState<string | undefined>(undefined)
  const [sending, setSending] = useState(false)

  // Channel decides the reply path, not the presence of a string: an SMS row
  // keeps the phone number in `fromAddress`, which used to read as an address.
  // A voicemail is answered by email when we know one, otherwise by SMS — there
  // is no voicemail-to-voicemail send.
  const channel: 'email' | 'sms' =
    detail?.channel === 'sms' ? 'sms' : detail?.replyToAddress ? 'email' : 'sms'
  const smsBlocked = channel === 'sms'

  // Reset the composer when the drawer opens on a DIFFERENT thread — keyed on
  // `detail.key`, never on the `detail` object itself.
  //
  // `detail` is a prop from a server component, so every parent re-render hands
  // down a fresh object with identical contents. Depending on it made this
  // effect fire on re-render and call `setBody('')`, silently wiping whatever
  // had been typed. InboxView marks a thread's messages read on open and then
  // calls `router.refresh()`, so the wipe landed a few hundred ms after the
  // thread opened — right while the user is typing their reply.
  //
  // The draft going empty also disables Send (`body.trim().length === 0`) with
  // no way back, which is what made `full-session › 5 · replying files onto the
  // thread` hang until the 180s timeout. full-session.spec.ts already carried a
  // note that asserting draft survival there "made it flaky … the drawer
  // re-renders as the thread refreshes" — that was this bug, observed and
  // worked around in the test rather than fixed here.
  const detailKey = detail?.key ?? null
  useEffect(() => {
    if (!open || !detail) return
    setSubject(detail.subject ? `Re: ${detail.subject.replace(/^re:\s*/i, '')}` : '')
    setBody('')
    setTemplateId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on
    // detailKey deliberately: adding `detail` restores the draft-wiping bug.
  }, [open, detailKey])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch(`/api/comms/templates?channel=${channel}`)
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
  }, [open, channel])

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id)
      const t = templates.find((x) => x.id === id)
      if (!t) return
      // Merge-field substitution is Agent D's, applied at send time on the
      // server. The composer inserts the raw template so what you see is what
      // is stored.
      if (t.subject) setSubject(t.subject)
      setBody(t.bodyText)
    },
    [templates],
  )

  const send = useCallback(async () => {
    if (!detail || smsBlocked) return
    setSending(true)
    try {
      const res = await fetch('/api/comms/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'email',
          // Files the reply onto the thread being answered instead of starting
          // a new one. Omitted (null) only for voicemail, which has no thread.
          threadId: detail.replyThreadId,
          leadId: detail.leadId,
          contactId: detail.contactId,
          toAddresses: detail.replyToAddress ? [detail.replyToAddress] : [],
          subject,
          bodyText: body,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.status === 'error') {
        toast({ tone: 'danger', title: 'Send failed', description: 'The message was not sent.' })
        return
      }
      toast({ tone: 'success', title: 'Sent', description: detail.replyToAddress ?? undefined })
      onSent()
    } catch {
      toast({ tone: 'danger', title: 'Send failed', description: 'The message was not sent.' })
    } finally {
      setSending(false)
    }
  }, [detail, smsBlocked, subject, body, toast, onSent])

  const templateOptions: SelectOption[] = templates.map((t) => ({ value: t.id, label: t.name }))

  const sendButton = (
    <Button
      variant="primary"
      onClick={send}
      loading={sending}
      disabled={smsBlocked || !detail || body.trim().length === 0}
    >
      <Send size={13} />
      Send
    </Button>
  )

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={detail ? `Reply to ${detail.title}` : 'Reply'}
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
          {smsBlocked ? <Tooltip content={SMS_DISABLED_REASON}>{sendButton}</Tooltip> : sendButton}
        </>
      }
    >
      {!detail ? (
        <p className="text-sm text-subtle">Open a thread to reply.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            label="To"
            readOnly
            value={detail.replyToAddress ?? detail.replyToPhone ?? ''}
            hint={smsBlocked ? SMS_DISABLED_REASON : undefined}
          />
          {channel === 'email' && (
            <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          )}
          <Textarea
            label="Message"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your reply…"
          />
          {templateOptions.length === 0 && (
            <p className="text-xs text-subtle">
              No {channel} templates yet. Create them under Templates.
            </p>
          )}
        </div>
      )}
    </Drawer>
  )
}
