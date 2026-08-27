import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getBoss } from '@/lib/comms/jobs/boss'
import { QUEUES } from '@/lib/comms/jobs/queues'

export const dynamic = 'force-dynamic'

// Called every ~5 min. Enqueues a delta-sync job per active Gmail credential.
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
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
