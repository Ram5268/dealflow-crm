import { NextResponse } from 'next/server'
import { getBoss } from '@/lib/comms/jobs/boss'
import { QUEUES } from '@/lib/comms/jobs/queues'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

// Gmail Pub/Sub push. Verify the shared token, decode the envelope, enqueue a
// delta-sync job, and return 200 fast. Malformed envelopes are swallowed with a
// 200 (Pub/Sub retries non-2xx for up to 7 days and would stall the whole feed).
export async function POST(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  if (token !== process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const dataB64: string | undefined = body?.message?.data
    if (!dataB64) throw new Error('missing message.data')
    const decoded = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8'))
    const emailAddress: string | undefined = decoded?.emailAddress
    const historyId: string | undefined = decoded?.historyId
    if (!emailAddress) throw new Error('missing emailAddress')

    const boss = await getBoss()
    await boss.send(
      QUEUES.GMAIL_DELTA_SYNC,
      { emailAddress, historyId },
      { singletonKey: `gmail:${emailAddress}` },
    )
  } catch (err) {
    logger.error({ err }, 'gmail-push: malformed envelope or enqueue failure')
  }

  return NextResponse.json({ ok: true })
}
