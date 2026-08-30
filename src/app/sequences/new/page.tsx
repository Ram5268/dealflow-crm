import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { listTemplateRows } from '@/lib/sequences/queries'
import { SequenceEditor } from '../SequenceEditor'

export const dynamic = 'force-dynamic'

export default async function NewSequencePage() {
  const organizationId = await getCurrentOrgId()
  return <SequenceEditor sequence={null} templates={await listTemplateRows(organizationId)} />
}
