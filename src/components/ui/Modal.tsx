'use client'

import * as RD from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/ui/cn'
import { IconButton } from './IconButton'

export const ModalRoot = RD.Root
export const ModalTrigger = RD.Trigger
export const ModalClose = RD.Close

const OVERLAY = cn(
  'fixed inset-0 z-40 bg-black/40',
  'data-[state=open]:animate-[dfFadeIn_120ms_ease-out]',
  'data-[state=closed]:animate-[dfFadeOut_100ms_ease-in]',
)

/**
 * Centered modal. Esc and backdrop-click close it (Radix default); the caller
 * owns open state so the same component works controlled or trigger-driven.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  className,
}: {
  open?: boolean
  onOpenChange?: (o: boolean) => void
  title: string
  description?: string
  footer?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className={OVERLAY} />
        <RD.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(560px,calc(100vw-2rem))]',
            '-translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-line bg-overlay shadow-lg',
            'data-[state=open]:animate-[dfPopIn_120ms_ease-out]',
            'data-[state=closed]:animate-[dfPopOut_100ms_ease-in]',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <RD.Title className="text-sm font-semibold text-fg">{title}</RD.Title>
              {description && (
                <RD.Description className="mt-0.5 text-xs text-muted">
                  {description}
                </RD.Description>
              )}
            </div>
            <RD.Close asChild>
              <IconButton label="Close" size="sm" tooltip={false}>
                <X size={14} />
              </IconButton>
            </RD.Close>
          </div>
          {children && <div className="px-4 py-3">{children}</div>}
          {footer && (
            <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

/**
 * Right-side sheet. Same dismissal contract as Modal (Esc + backdrop), but
 * anchored to the edge — used for detail panes that keep page context visible.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  width = 420,
  children,
  className,
}: {
  open?: boolean
  onOpenChange?: (o: boolean) => void
  title: string
  width?: number
  children?: React.ReactNode
  className?: string
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className={OVERLAY} />
        <RD.Content
          style={{ width: `min(${width}px, 100vw)` }}
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full flex-col',
            'border-l border-line bg-overlay shadow-lg',
            'data-[state=open]:animate-[dfSlideInRight_160ms_ease-out]',
            'data-[state=closed]:animate-[dfSlideOutRight_140ms_ease-in]',
            className,
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-4 py-3">
            <RD.Title className="truncate text-sm font-semibold text-fg">{title}</RD.Title>
            <RD.Close asChild>
              <IconButton label="Close" size="sm" tooltip={false}>
                <X size={14} />
              </IconButton>
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
