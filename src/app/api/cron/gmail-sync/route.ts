import { NextResponse } from 'next/server'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { prisma } from '@/lib/prisma'
import { getBoss } from '@/lib/comms/jobs/boss'
import { QUEUES } from '@/lib/comms/jobs/queues'

export const dynamic = 'force-dynamic'

// Called every ~5 min. Enqueues a delta-sync job per active Gmail credential.
export async function GET(req: Request) {
  // Brief 41.2 (PR F), engineering precaution: the shared check refuses when
  // CRON_SECRET is unset too. The old comparison let "Bearer undefined" in.
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const start = Date.now()

  const creds = await prisma.oAuthCredential.findMany({
    where: { provider: 'gmail', status: 'active' },
    select: { id: true },
  })

  const boss = await getBoss()
  for (const c of creds) {
    await boss.send(
      QUEUES.GMAIL_DELTA_SYNC,
      { credentialId: c.id },
      { singletonKey: `cred:${c.id}` },
    )
  }

  return NextResponse.json({
    ran: true,
    processed: creds.length,
    durationMs: Date.now() - start,
  })
}
