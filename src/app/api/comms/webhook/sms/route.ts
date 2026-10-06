import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { verifyTwilioSignature } from '@/lib/comms/sms/twilio-client'
import { handleInboundSms, updateDeliveryState } from '@/lib/comms/sms/inbound'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const twiml = () =>
  new NextResponse(TWIML_OK, { status: 200, headers: { 'content-type': 'text/xml' } })

// Twilio inbound SMS + delivery-status callbacks. Verify X-Twilio-Signature,
// then dispatch by shape: MessageStatus (no Body) = delivery callback; otherwise
// an inbound message (STOP handled inside handleInboundSms). 200 TwiML when the
// message is handled. Brief 41 (H12): if saving it or recording a STOP fails,
// answer 500, never 200: a 200 told Twilio all was well and the opt-out was
// lost. A redelivery is safe (the message is saved once per MessageSid).
export async function POST(req: Request) {
  const rawBody = await req.text()
  const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>

  const skipSig = process.env.TWILIO_MOCK_SKIP_SIGNATURE === 'true'
  if (!skipSig) {
    const ok = verifyTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN ?? '',
      req.url,
      params,
      req.headers.get('x-twilio-signature'),
    )
    if (!ok) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  // Delivery-status callback.
  if (params.MessageStatus && params.MessageSid && !params.Body) {
    await updateDeliveryState(params.MessageSid, params.MessageStatus)
    return twiml()
  }

  // Inbound message.
  try {
    const orgId = await getCurrentOrgId()
    await handleInboundSms({
      orgId,
      from: params.From,
      to: params.To,
      body: params.Body ?? '',
      messageSid: params.MessageSid,
    })
  } catch (err) {
    logger.error({ err }, 'sms inbound handler failed')
    return NextResponse.json({ error: 'inbound_sms_failed' }, { status: 500 })
  }
  return twiml()
}
