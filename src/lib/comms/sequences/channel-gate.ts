import { emailEnabled } from '../email/config'
import { smsEnabled } from '../sms/config'

/**
 * Brief 41.2 (PR E): no new sequence enrollment while a channel the sequence
 * uses is off. Email steps need EMAIL_ENABLED and text steps need SMS_ENABLED,
 * each on only when exactly 'true' (the existing switches, read here, never
 * set).
 *
 * Engineering precaution (audit H15), serving Ryan's instruction that nothing
 * contacts a lead: an enrollment made while a switch is off stays active, and
 * once the switch goes on the tick fires every overdue step at once, with no
 * opt-out, do-not-call or reply check. The tick and sending are unchanged here;
 * that is go-live work. Showing "Add to sequence" greyed out with the reason,
 * rather than hiding it, is Ryan's decision of 2026-10-17.
 */

type Env = Record<string, string | undefined>

/** What the check needs to know about a sequence. */
export interface SequenceChannelsInput {
  channel: string
  steps: readonly { channel: string }[]
}

/**
 * Every channel a sequence uses: each step's channel plus the sequence's own
 * ('mixed' counts as both). The sequence's own channel counts even when no step
 * uses it yet, because steps can be edited after someone is enrolled.
 */
export function sequenceChannels(seq: SequenceChannelsInput): string[] {
  const used = new Set<string>(seq.channel === 'mixed' ? ['email', 'sms'] : [seq.channel])
  for (const step of seq.steps) used.add(step.channel)
  return [...used].sort()
}

function channelOn(channel: string, env: Env): boolean {
  if (channel === 'email') return emailEnabled(env)
  if (channel === 'sms') return smsEnabled(env)
  // A channel the CRM can't send counts as off (fail closed).
  return false
}

/** The channels this sequence uses that are off right now. */
export function channelsOff(seq: SequenceChannelsInput, env: Env = process.env): string[] {
  return sequenceChannels(seq).filter((channel) => !channelOn(channel, env))
}

/** One plain line saying why this sequence can't start, or null if it can. */
export function enrollBlockedReason(seq: SequenceChannelsInput, env: Env = process.env): string | null {
  const off = channelsOff(seq, env)
  if (off.length === 0) return null
  if (off.some((c) => c !== 'email' && c !== 'sms')) {
    return "This sequence uses a channel the CRM can't send, so it can't start."
  }
  const what = off.length === 2 ? 'Email and texting are' : off[0] === 'email' ? 'Email is' : 'Texting is'
  return `${what} off, so this sequence can't start.`
}

export class SequenceChannelOffError extends Error {
  readonly code = 'sequence_channel_off'
  constructor(
    readonly channels: string[],
    message: string,
  ) {
    super(message)
    this.name = 'SequenceChannelOffError'
  }
}

/**
 * Throws SequenceChannelOffError unless every channel the sequence uses is on.
 * Checked when an enrollment is created and when one is resumed: a resumed
 * enrollment would fire at switch-on just like a new one.
 */
export function assertSequenceCanStart(seq: SequenceChannelsInput, env: Env = process.env): void {
  const reason = enrollBlockedReason(seq, env)
  if (reason) throw new SequenceChannelOffError(channelsOff(seq, env), reason)
}

/** The 403 both enrollment routes answer while a channel is off; nothing was saved. */
export function sequenceChannelOffResponse(err: SequenceChannelOffError): Response {
  return Response.json({ error: err.code, message: err.message, channels: err.channels }, { status: 403 })
}

export const SEQUENCES_OFF_REASON = "Email and texting are off, so sequences can't start."

/**
 * Why "Add to sequence" is greyed out (the lead page and the Leads list's bulk
 * action): every sequence sends email or texts, so with both off none can
 * start. Null once either is on; the server then checks each sequence.
 */
export function sequencesOffReason(env: Env = process.env): string | null {
  return emailEnabled(env) || smsEnabled(env) ? null : SEQUENCES_OFF_REASON
}

/**
 * The /sequences banner. `people` is how many distinct contacts have an active
 * enrollment. Shown only while both switches are off, because that is what it
 * says; null when nobody is enrolled.
 */
export function enrolledWhileOffBanner(people: number, env: Env = process.env): string | null {
  if (!(people > 0) || emailEnabled(env) || smsEnabled(env)) return null
  const who = people === 1 ? '1 person is' : `${people} people are`
  return `${who} enrolled in sequences. Nothing sends while email and texting are off. Review them before switching either on.`
}
