'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Button, EmptyState } from '@/components/ui'

// Brief 50 PR 2 (open item 6.2, audit M27): what the CRM shows when a page
// breaks, instead of Next's generic error screen. Used by src/app/error.tsx,
// src/app/global-error.tsx and src/app/leads/[id]/error.tsx.
//
// No error message or stack on screen [engineering precaution: a message can
// carry a lead's details or database internals, and it means nothing to the
// reader]. Next's short digest is shown as a "Reference": the server's log
// line for the same error carries it.

/** What Next 16.2 hands an error page. */
export interface ErrorPageProps {
  error: Error & { digest?: string }
  /** Re-draws what the browser already has. A failed server read fails again. */
  reset: () => void
  /** Re-reads the page from the server, then re-draws it (Next 16.2+). */
  unstable_retry?: () => void
}

/** "Try again": re-read from the server when Next offers it, else re-draw. */
export function retryOf({ reset, unstable_retry }: ErrorPageProps): () => void {
  return unstable_retry ?? reset
}

/**
 * One line in the browser's console. Sentry isn't wired (no Sentry address is
 * set anywhere we can see; see src/lib/shared/sentry.ts), and an error page
 * runs in the browser, so it can't reach the server's logger.
 */
export function logPageError(where: string, error: Error & { digest?: string }): void {
  console.error(`[error page: ${where}]`, error.digest ? `reference ${error.digest}` : 'no reference', error)
}

export function ErrorScreen({
  title,
  description,
  digest,
  onRetry,
  backHref,
  backLabel,
  fullReload = false,
}: {
  title: string
  description: string
  digest?: string
  onRetry: () => void
  backHref: string
  backLabel: string
  /** A plain link (a full page load) instead of an in-app one. For global-error. */
  fullReload?: boolean
}) {
  return (
    <div role="alert">
      <EmptyState
        icon={<AlertTriangle />}
        title={title}
        description={description}
        action={
          <div className="flex flex-col items-center gap-3">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={() => onRetry()}>
                Try again
              </Button>
              <Button asChild>
                {fullReload ? <a href={backHref}>{backLabel}</a> : <Link href={backHref}>{backLabel}</Link>}
              </Button>
            </div>
            {digest && (
              <p className="text-xs text-subtle">
                Reference: <span className="font-mono">{digest}</span>
              </p>
            )}
          </div>
        }
      />
    </div>
  )
}
