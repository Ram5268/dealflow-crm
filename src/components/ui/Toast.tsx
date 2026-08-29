'use client'

import * as RT from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { cn } from '@/lib/ui/cn'
import { IconButton } from './IconButton'

export type ToastTone = 'neutral' | 'success' | 'danger'

interface ToastItem {
  id: number
  title: string
  description?: string
  tone: ToastTone
}

interface ToastContextValue {
  toast: (t: { title: string; description?: string; tone?: ToastTone }) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

const TONE_BAR: Record<ToastTone, string> = {
  neutral: 'bg-line-strong',
  success: 'bg-success',
  danger: 'bg-danger',
}

let nextId = 1

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const toast = useCallback(
    ({ title, description, tone = 'neutral' }: { title: string; description?: string; tone?: ToastTone }) => {
      setItems((prev) => [...prev, { id: nextId++, title, description, tone }])
    },
    [],
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      <RT.Provider duration={4000} swipeDirection="right">
        {children}
        {items.map((t) => (
          <RT.Root
            key={t.id}
            // Drop it from state on close so the list cannot grow unbounded
            // across a long dialing session.
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((i) => i.id !== t.id))
            }}
            className={cn(
              'relative flex items-start gap-3 overflow-hidden rounded-md',
              'border border-line bg-overlay py-2 pl-3 pr-2 shadow-md',
              'data-[state=open]:animate-[dfSlideInRight_160ms_ease-out]',
              'data-[state=closed]:animate-[dfFadeOut_100ms_ease-in]',
            )}
          >
            <span className={cn('absolute inset-y-0 left-0 w-0.5', TONE_BAR[t.tone])} />
            <div className="min-w-0 flex-1">
              <RT.Title className="text-sm font-medium text-fg">{t.title}</RT.Title>
              {t.description && (
                <RT.Description className="mt-0.5 text-xs text-muted">
                  {t.description}
                </RT.Description>
              )}
            </div>
            <RT.Close asChild>
              <IconButton label="Dismiss" size="sm" tooltip={false}>
                <X size={13} />
              </IconButton>
            </RT.Close>
          </RT.Root>
        ))}
        <RT.Viewport className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2 outline-none" />
      </RT.Provider>
    </ToastContext.Provider>
  )
}
