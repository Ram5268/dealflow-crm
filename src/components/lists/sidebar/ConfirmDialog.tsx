'use client'

import * as RD from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui'
import { cn } from '@/lib/ui/cn'

/**
 * Brief 45 — "Delete this list / group?" before anything is deleted. Same look
 * as the kit's Modal; built on the dialog primitive so the sidebar decides
 * where keyboard focus lands afterwards (the row again, or the next sensible
 * place when the row is gone).
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  onClosed,
}: {
  open: boolean
  title: string
  body: React.ReactNode
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  /** After it closes, instead of the dialog's own focus return. */
  onClosed?: () => void
}) {
  return (
    <RD.Root open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-[dfFadeIn_120ms_ease-out]" />
        <RD.Content
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            onClosed?.()
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-line bg-overlay shadow-lg',
            'data-[state=open]:animate-[dfPopIn_120ms_ease-out]',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <RD.Title className="min-w-0 break-words text-sm font-semibold text-fg">{title}</RD.Title>
            <RD.Close asChild>
              <IconButton label="Close" size="sm" tooltip={false} disabled={busy}>
                <X size={14} />
              </IconButton>
            </RD.Close>
          </div>
          <RD.Description asChild>
            <div className="px-4 py-3 text-sm text-fg">{body}</div>
          </RD.Description>
          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
