import { NextResponse } from 'next/server'
import { runSequenceTick } from '@/lib/comms/sequences/tick'

export const dynamic = 'force-dynamic'

// Advances due SequenceEnrollments. Called every ~15 min.
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const start = Date.now()
  const r = await runSequenceTick()
  return NextResponse.json({
    ran: true,
    processed: r.processed,
    sent: r.sent,
    finished: r.finished,
    errored: r.errored,
    durationMs: Date.now() - start,
  })
}
