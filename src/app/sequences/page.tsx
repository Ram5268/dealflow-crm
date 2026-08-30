import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { listSequenceRows } from '@/lib/sequences/queries'
import { SequencesView } from './SequencesView'

export const dynamic = 'force-dynamic'

export default async function SequencesPage() {
  const organizationId = await getCurrentOrgId()
  return <SequencesView sequences={await listSequenceRows(organizationId)} />
}
