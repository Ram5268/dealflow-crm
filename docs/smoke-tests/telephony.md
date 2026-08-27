# Telephony smoke test (Ryan) — real Twilio test call

Verifies the slice end-to-end before integration. Needs Twilio TEST creds + a
public tunnel. No other agent's services required.

## Prereqs (Ryan provisions)

1. Twilio test creds in `worktrees/agent-b/.env` (or Doppler):
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`,
   `TWILIO_API_KEY_SECRET`, `TWILIO_APP_SID`.
2. A verified caller ID: `TWILIO_CALLER_ID_NUMBER` (E.164).
3. A tunnel exposing localhost:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Put the public URL in `TWILIO_VOICE_WEBHOOK_BASE=https://<tunnel>/api/telephony/webhook`
   and `TWILIO_RECORDING_STATUS_CALLBACK=https://<tunnel>/api/telephony/webhook/recording`.
   Point the TwiML App's Voice URL at `https://<tunnel>/api/telephony/voice/conference`.

## Steps

```bash
# 1. Boot mocks + slice
pnpm mocks:up
QUEUE_SERVICE_BASE_URL=http://localhost:4101 COMPLIANCE_BASE_URL=http://localhost:4102 \
  doppler run --config dev -- pnpm dev

# 2. Health
curl http://localhost:3000/api/telephony/health           # {status:"ok", halted:false}

# 3. Softphone token (browser at /dialer registers the Voice Device)
open http://localhost:3000/dialer

# 4. Create a POWER session (single-line — no loser-message dependency)
curl -X POST http://localhost:3000/api/telephony/dial-sessions \
  -H 'content-type: application/json' \
  -d '{"viewId":"save_mocktest","method":"power","lineCount":1,"callerId":"+1YOURCALLERID"}'
```

## Expected

- The mock queue returns a canned number; inline compliance (mock) returns
  callable. `placeCall` dials via Twilio test creds to your cell.
- Answer → AMD `human` → operator bridged into `conf_<callId>` → you hear
  yourself; ammunition panel populates **within 200ms** of `call.connected`.
- Hang up → `webhook/status` `completed` → `call.completed` emitted
  (`Call.status='completed'`, `disposition='answered'`, `source='dealflow-crm'`).
- If a recording is configured → `webhook/recording` stores it in R2;
  `GET /api/telephony/calls/<id>/recording` 302-redirects to a presigned URL.

## Predictive (multi-line) note

`method=predictive` is REFUSED with `loser_twiml_unapproved` until
`LOSER_TWIML_APPROVED=true` (belt+suspenders for FCC abandoned-call rules). Set
it only after approving the dropped-loser message
(`RACE_LOSER_TWIML_MODE/_TEXT/_MP3_URL`).

## Wire-shape audit (5 min, before first PRODUCTION dial)

Capture one real payload of each and assert:
- `call.completed`: `type` present, `cost` is a string.
- `/api/queue`: `primaryPhoneE164` present (not `primaryPhone`).
- `callable-now`: every result has `contactPhoneId` + `phone`; every `reasons[]`
  value ∈ REASON_CODES.
Any failure = the upstream agent drifted from an §8.3 lock → file §13, do NOT dial.
