'use client'

import { useEffect } from 'react'
import { ErrorScreen, logPageError, retryOf, type ErrorPageProps } from '@/components/ErrorScreen'

// Brief 50 PR 2: the lead page reads from several places at once (the CRM,
// DealFlow's buyers and values), so it gets its own error screen that says
// which page broke and leads back to the list.
export default function LeadError(props: ErrorPageProps) {
  const { error } = props
  useEffect(() => {
    logPageError('lead page', error)
  }, [error])

  return (
    <ErrorScreen
      title="This lead couldn't load"
      description="Something went wrong while opening this lead. Try again in a moment, or go back to Leads."
      digest={error.digest}
      onRetry={retryOf(props)}
      backHref="/leads"
      backLabel="Back to Leads"
    />
  )
}
