import { NextResponse } from 'next/server'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { runSequenceTick } from '@/lib/comms/sequences/tick'

export const dynamic = 'force-dynamic'

// Advances due SequenceEnrollments. Called every ~15 min.
export async function GET(req: Request) {
  // Brief 41.2 (PR F), engineering precaution: the shared check refuses when
  // CRON_SECRET is unset too. The old comparison let "Bearer undefined" in.
  if (!isAuthorizedCron(req)) {
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
