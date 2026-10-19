'use client'

import { useEffect } from 'react'
import { ErrorScreen, logPageError, retryOf, type ErrorPageProps } from '@/components/ErrorScreen'

// Brief 50 PR 2: any page that breaks shows this inside the app (the sidebar
// and top bar stay), instead of Next's generic error screen. Covers every
// page without its own error.tsx, including the Queue and Settings.
export default function PageError(props: ErrorPageProps) {
  const { error } = props
  useEffect(() => {
    logPageError('page', error)
  }, [error])

  return (
    <ErrorScreen
      title="Something went wrong on this page"
      description="The CRM hit a problem showing this page. Try again in a moment, or go to Leads."
      digest={error.digest}
      onRetry={retryOf(props)}
      backHref="/leads"
      backLabel="Go to Leads"
    />
  )
}
