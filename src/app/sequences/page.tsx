import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { countPeopleInActiveSequences, listSequenceRows } from '@/lib/sequences/queries'
import { enrolledWhileOffBanner } from '@/lib/comms/sequences/channel-gate'
import { SequencesView } from './SequencesView'

export const dynamic = 'force-dynamic'

export default async function SequencesPage() {
  const organizationId = await getCurrentOrgId()
  const [sequences, people] = await Promise.all([
    listSequenceRows(organizationId),
    countPeopleInActiveSequences(organizationId),
  ])
  return <SequencesView sequences={sequences} banner={enrolledWhileOffBanner(people)} />
}
