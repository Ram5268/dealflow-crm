# 10DLC Registration Status — Agent D (Communications)

> **Why this matters:** Unregistered A2P 10DLC SMS in the US has been **fully
> blocked since Feb 2025** — messages silently fail. Nothing in the SMS path
> (Milestone 4) works until Brand + Campaign are **APPROVED** and a Messaging
> Service SID is attached. Vetting is **calendar time (1–4 weeks)**, not work
> time. File on Day 1.

## Current status

| Item | Value | Status |
|---|---|---|
| Trust Hub Brand | `TWILIO_10DLC_BRAND_ID` | ⛔ NOT FILED — awaiting Ryan |
| A2P Campaign | `TWILIO_10DLC_CAMPAIGN_ID` | ⛔ NOT FILED — awaiting Ryan |
| Messaging Service | `TWILIO_MESSAGING_SERVICE_SID` | ⛔ pending (attach after campaign approves) |
| 10DLC phone number | — | ⛔ pending (add under Messaging Service) |
| Submission date | — | — |
| Approval date | — | — |
| `sms.enabled` runtime flag | `false` | ✅ correct until SIDs land |

**Executor cannot file this** — it requires Ryan's Twilio Console login and his
SSN/EIN + business identity. This document is the fill-in-the-blanks packet.
Once filed, update the table above and the SID env vars in Doppler.

## What Ryan needs to file (Twilio Console → Trust Hub → Register Brand)

### 1. Brand registration (Sole Proprietor)
- **Business type:** Sole Proprietor
- **Legal name:** Ryan Martin
- **EIN or SSN:** _(Ryan provides — required for vetting; do NOT paste into repo/chat)_
- **Business address:** Ryan's Douglas Elliman office address _(confirm)_
- **Business email:** _(Ryan's Elliman email or the CRM's broker@ alias — confirm which)_
- **Business URL:** Ryan's `douglaselliman.com` agent profile page _(confirm exact URL — a public-facing page is required)_
- **Vertical:** Real Estate
- Cost: ~$4/mo brand fee.

### 2. Campaign registration (under the Brand)
- **Use case:** "Real Estate Agent — Prospect & Client Outreach" (Low Volume Mixed / Standard)
- **Campaign description:** "Two-way SMS between a licensed NYC real-estate agent
  (Douglas Elliman) and his own prospects and clients regarding listings, showings,
  offers, and follow-up. Contacts are people the agent already has a relationship or
  signed agreement with. No marketing to purchased lists."
- **Opt-in method / evidence:** "Consumer provides their phone number via a signed
  listing agreement, buyer-representation agreement, an inbound inquiry, or an
  in-person/phone conversation. Opt-in consent language and its source are stored in
  the CRM per contact. No web form is used at launch."
- **Opt-out:** "Reply STOP to opt out." (Enable Twilio **Advanced Opt-Out** so the
  'You have been unsubscribed' auto-reply is sent automatically.)
- **Help:** "Reply HELP for help."
- **Sample messages:** see below (Twilio requires 2–5).

### 3. Messaging Service + number
- Create a Twilio **Messaging Service**; attach the approved campaign.
- Add at least one 10DLC / long-code number under it.
- Store the Messaging Service SID → Doppler `TWILIO_MESSAGING_SERVICE_SID`.
- Point the Messaging Service **inbound + status-callback webhooks** at
  `POST /api/comms/webhook/sms` (production HTTPS URL), with the retry settings
  below.

### 4. Webhook go-live settings (Brief 41.1)
- **Set `TWILIO_AUTH_TOKEN` in Vercel first.** Without it the webhook answers
  **503** to every request, because it can't check Twilio's signature. It used to
  check against an empty token, which anyone could forge.
  `TWILIO_MOCK_SKIP_SIGNATURE` is for the local mocks only and is ignored in
  production.
- **Ask Twilio to retry failures.** By default Twilio retries only when it can't
  connect, not when the webhook answers 500. The webhook answers 500 when it saved
  a text but couldn't record its opt-out. Add Twilio's connection overrides to the
  end of the webhook URL:

  `https://dealflow-crm-rho.vercel.app/api/comms/webhook/sms#rc=3&rp=5xx,ct,rt`

  - `rc=3`: up to 3 retries (Twilio allows at most 5).
  - `rp=5xx,ct,rt`: retry on a 5xx answer, a failed connection, or a read timeout.
    Don't retry 4xx: a 401 is a bad signature.
  - Twilio doesn't sign the `#…` part, so signature checks are unaffected.
  - A retried text is saved once (keyed by its MessageSid), and re-adding an
    opt-out does nothing.
  - Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides
- **Opt-out words.** STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT,
  REVOKE, OPT OUT / OPTOUT / OPT-OUT, REMOVE ME, DO NOT TEXT and DON'T TEXT count
  as opt-outs, in any capitals and with any punctuation
  (`src/lib/comms/sms/opt-out.ts`).
  - A longer text that contains one of them ("please stop texting me") is an
    opt-out too. On the opt-out list it gets the reason `sms_stop_phrase`
    (`sms_stop_received` for a plain keyword), so these can be reviewed.
  - This includes innocent texts like "can you stop by Tuesday?". That's
    deliberate: when in doubt, treat it as an opt-out.
- **Lost STOPs.** After any webhook outage, run the sweep. It adds the opt-out for
  any saved STOP text that has none, and the dry run is the default:
  `npx tsx scripts/brief41-1-stop-sweep.ts` (then `--apply --i-mean-live`, only
  with Ryan's OK).

## Sample messages filed (draft — compliant: identity + opt-out)

1. > Hi {{contact.firstName}}, this is Ryan Martin with Douglas Elliman. I have a
   > coming-soon listing near you I think fits what you're after. Want the details?
   > Reply STOP to opt out.

2. > {{contact.firstName}}, Ryan here (Douglas Elliman). Following up on the
   > {{lead.primaryAddressSummary}} showing — are you still interested? Reply STOP to
   > opt out, HELP for help.

3. > Hi {{contact.firstName}}, it's Ryan from Douglas Elliman. The seller responded to
   > your offer — can I call you in the next hour? Msg&data rates may apply. Reply STOP
   > to opt out.

4. > {{contact.firstName}}, Ryan Martin / Douglas Elliman. New price on the unit you
   > liked. Reply YES for the number or STOP to opt out.

5. > Hi {{contact.firstName}}, this is Ryan with Douglas Elliman confirming our
   > appointment {{appointmentTime}}. Reply STOP to opt out.

All samples: (a) identify the sender + business, (b) include STOP opt-out, (c) are
transactional/relationship-based, not cold marketing. Keep them representative of
what the template library actually sends.

## Runtime guard while pending (already the plan)

- Config flag `sms.enabled` defaults to **`false`**.
- Every SMS send handler returns **HTTP 503** `{ error: "sms_pending_10dlc" }` while
  the flag is off. Email + sequences (email-only) ship without waiting on 10DLC.
- Flip `sms.enabled=true` only after `TWILIO_MESSAGING_SERVICE_SID` is populated and
  the campaign shows **APPROVED**.

## Tracking

Check weekly with Ryan. Update this file on each state change. If the clock runs out
before integration, **integration ships email-only** and SMS lands as a follow-on
(Brief §16 known-open item; handoff notes `10DLC: PENDING`).
