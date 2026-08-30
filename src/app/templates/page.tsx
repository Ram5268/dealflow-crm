import { Suspense } from 'react'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { listTemplateRows } from '@/lib/sequences/queries'
import { TemplatesView } from './TemplatesView'

export const dynamic = 'force-dynamic'

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>
}) {
  const organizationId = await getCurrentOrgId()
  const { channel } = await searchParams
  const valid = channel === 'email' || channel === 'sms' ? channel : ''
  const templates = await listTemplateRows(organizationId, valid || undefined)

  // useSearchParams needs a Suspense boundary to stay statically analysable.
  return (
    <Suspense>
      <TemplatesView templates={templates} channel={valid} />
    </Suspense>
  )
}
