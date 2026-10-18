import { notFound } from 'next/navigation'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getSequenceDetail } from '@/lib/sequences/queries'
import { enrollBlockedReason } from '@/lib/comms/sequences/channel-gate'
import { SequenceDetailView } from './SequenceDetailView'

export const dynamic = 'force-dynamic'

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const organizationId = await getCurrentOrgId()
  const { id } = await params
  const sequence = await getSequenceDetail(organizationId, id)
  if (!sequence) notFound()
  // Brief 41.2 (PR E): the switches are server settings, so whether this
  // sequence can start or resume is decided here.
  return <SequenceDetailView sequence={sequence} blockedReason={enrollBlockedReason(sequence)} />
}
