import { NextResponse } from 'next/server'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { prisma } from '@/lib/prisma'
import { graphEnabled } from '@/lib/comms/graph-switch'
import { getBoss } from '@/lib/comms/jobs/boss'
import { QUEUES } from '@/lib/comms/jobs/queues'

export const dynamic = 'force-dynamic'

// Polls Graph delta per active msft-graph credential (Graph push needs public
// HTTPS + subscription renewal; MVP polls every ~5 min).
export async function GET(req: Request) {
  // Brief 41.2 (PR F), engineering precaution: the shared check refuses when
  // CRON_SECRET is unset too. The old comparison let "Bearer undefined" in.
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const start = Date.now()
  // Brief 41.2: Outlook is paused (Ryan's instruction). Nothing is read or
  // queued, so no Outlook mailbox is synced.
  if (!graphEnabled()) return NextResponse.json({ ran: false, reason: 'outlook paused' })

  const creds = await prisma.oAuthCredential.findMany({
    where: { provider: 'msft-graph', status: 'active' },
    select: { id: true },
  })

  const boss = await getBoss()
  for (const c of creds) {
    await boss.send(QUEUES.GRAPH_DELTA_SYNC, { credentialId: c.id }, { singletonKey: `graph:${c.id}` })
  }

  return NextResponse.json({ ran: true, processed: creds.length, durationMs: Date.now() - start })
}
