'use client'

import * as RD from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/ui/cn'
import { IconButton } from './IconButton'

/**
 * Persistent drawer — same anatomy as Sheet but NON-MODAL: no backdrop, no
 * focus trap, page stays scrollable and clickable behind it. This is the
 * reply-in-place surface (brief §4), where the point is composing WITHOUT
 * losing the thread you are replying to.
 *
 * Esc still closes it (Radix handles that even when modal={false}).
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  width = 460,
  footer,
  children,
  className,
}: {
  open?: boolean
  onOpenChange?: (o: boolean) => void
  title: string
  width?: number
  footer?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <RD.Portal>
        <RD.Content
          style={{ width: `min(${width}px, 100vw)` }}
          // Non-modal Radix content still traps initial focus; that is wanted
          // here (you open it to type) but we must NOT steal focus back on close.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'fixed bottom-0 right-4 z-40 flex max-h-[70vh] flex-col',
            'rounded-t-lg border border-b-0 border-line bg-overlay shadow-lg',
            'data-[state=open]:animate-[dfSlideInUp_160ms_ease-out]',
            className,
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-3 py-2">
            <RD.Title className="truncate text-sm font-semibold text-fg">{title}</RD.Title>
            <RD.Close asChild>
              <IconButton label="Close" size="sm" tooltip={false}>
                <X size={14} />
              </IconButton>
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">{children}</div>
          {footer && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2">
              {footer}
            </div>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

/**
 * Brief 45 — the navigation drawer: slides in from the left at phone width and
 * holds the whole sidebar. Unlike the reply Drawer above it is MODAL (backdrop,
 * focus trap, Esc or a backdrop tap closes it), because it covers the page.
 * The content brings its own layout; the title is for screen readers.
 */
export function SideDrawer({
  open,
  onOpenChange,
  title,
  width = 288,
  onEscapeKeyDown,
  children,
  className,
}: {
  open?: boolean
  onOpenChange?: (o: boolean) => void
  title: string
  width?: number
  /** Call preventDefault() to keep it open (e.g. Esc belongs to a name box inside). */
  onEscapeKeyDown?: (e: KeyboardEvent) => void
  children?: React.ReactNode
  className?: string
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-[dfFadeIn_120ms_ease-out]" />
        <RD.Content
          aria-describedby={undefined}
          onEscapeKeyDown={onEscapeKeyDown}
          style={{ width: `min(${width}px, 85vw)` }}
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-line bg-bg shadow-lg',
            'data-[state=open]:animate-[dfSlideInLeft_160ms_ease-out]',
            className,
          )}
        >
          <RD.Title className="sr-only">{title}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
