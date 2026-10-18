import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { captureException } from '@/lib/shared/sentry'
import { loadPipelinePage } from './load'
import { PipelineView } from './PipelineView'
import { PipelineLoadError } from './PipelineLoadError'
import type { PipelinePageData } from './types'

export const dynamic = 'force-dynamic'

// Brief 45 PR D: the Pipeline page [brief §5.6] — every group as a column
// (or one table), filters in the URL, saved workflows as tabs. The server
// reads (load.ts, through PR A's query); PipelineView moves cards and saves
// workflows through PR A's API. Organization only: nothing here contacts
// anyone [Ryan, 2026-09-24].
export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  let data: PipelinePageData
  try {
    data = await loadPipelinePage(await getCurrentOrgId(), await searchParams)
  } catch (err) {
    captureException(err, { route: '/pipeline' })
    return <PipelineLoadError />
  }
  return <PipelineView {...data} />
}
