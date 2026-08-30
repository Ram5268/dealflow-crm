import { notFound } from 'next/navigation'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getSequenceDetail, listTemplateRows } from '@/lib/sequences/queries'
import { SequenceEditor } from '../../SequenceEditor'

export const dynamic = 'force-dynamic'

export default async function EditSequencePage({ params }: { params: Promise<{ id: string }> }) {
  const organizationId = await getCurrentOrgId()
  const { id } = await params
  const [sequence, templates] = await Promise.all([
    getSequenceDetail(organizationId, id),
    listTemplateRows(organizationId),
  ])
  if (!sequence) notFound()
  return <SequenceEditor sequence={sequence} templates={templates} />
}
