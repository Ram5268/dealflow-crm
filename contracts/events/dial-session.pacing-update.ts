import { z } from 'zod'

// Emitted by Agent B's pacing worker on channel `crm_call` every tick. Consumer
// is the Ops dashboard (post-MVP). Agent A subscribes to `crm_call` but ignores
// unknown `type` values.
//
// §13 S5 (planner-blessed 2026-08-27): shape amended to carry `band` + `reason`
// (the whole point of a pacing emission — Ops needs which band fired and why the
// line count changed), keeping the `type` discriminant for crm_call channel
// consistency with call.connected / call.completed. Field names match the M1a
// control-law variables (rollingAbandonment is window-agnostic).
export const PacingUpdateEvent = z.object({
  type: z.literal('dial-session.pacing-update'),
  callId: z.string().optional(),
  sessionId: z.string(),
  lineCount: z.number().int(),
  rollingAbandonment: z.number(), // fraction, 0.0–1.0
  band: z.enum(['below_1_5', '1_5_to_2_0', '2_0_to_2_5', '2_5_to_2_8', 'above_2_8']),
  reason: z.string(),
  correlationId: z.string().uuid(),
})

export type PacingUpdateEvent = z.infer<typeof PacingUpdateEvent>
