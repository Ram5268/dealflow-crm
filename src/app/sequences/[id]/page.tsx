import { notFound } from 'next/navigation'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getSequenceDetail } from '@/lib/sequences/queries'
import { SequenceDetailView } from './SequenceDetailView'

export const dynamic = 'force-dynamic'

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const organizationId = await getCurrentOrgId()
  const { id } = await params
  const sequence = await getSequenceDetail(organizationId, id)
  if (!sequence) notFound()
  return <SequenceDetailView sequence={sequence} />
}
