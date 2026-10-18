import { describe, it, expect } from 'vitest'
import {
  sequenceChannels,
  channelsOff,
  enrollBlockedReason,
  assertSequenceCanStart,
  SequenceChannelOffError,
  sequenceChannelOffResponse,
  sequencesOffReason,
  SEQUENCES_OFF_REASON,
  enrolledWhileOffBanner,
} from './channel-gate'

// Brief 41.2 (PR E). Every check takes the environment as an argument, so these
// tests never touch the real switches.
const OFF = [undefined, '', 'false', '0', '1', 'TRUE', 'True', ' true', 'true ', 'yes']
const env = (email?: string, sms?: string) => ({ EMAIL_ENABLED: email, SMS_ENABLED: sms })
const seq = (channel: string, ...steps: string[]) => ({ channel, steps: steps.map((c) => ({ channel: c })) })

describe('sequenceChannels', () => {
  it("is the sequence's own channel plus every step's, once each", () => {
    expect(sequenceChannels(seq('email', 'email', 'email'))).toEqual(['email'])
    expect(sequenceChannels(seq('sms', 'sms'))).toEqual(['sms'])
    expect(sequenceChannels(seq('email', 'email', 'sms'))).toEqual(['email', 'sms'])
  })

  it("counts 'mixed' as both, even before any step uses one of them", () => {
    expect(sequenceChannels(seq('mixed'))).toEqual(['email', 'sms'])
    expect(sequenceChannels(seq('mixed', 'email'))).toEqual(['email', 'sms'])
  })

  it('keeps a channel the CRM cannot send, so the check can refuse it', () => {
    expect(sequenceChannels(seq('email', 'voice'))).toEqual(['email', 'voice'])
  })
})

describe('channelsOff', () => {
  it('each switch is on only when it is exactly "true"', () => {
    for (const v of OFF) {
      expect(channelsOff(seq('email', 'email'), env(v, 'true'))).toEqual(['email'])
      expect(channelsOff(seq('sms', 'sms'), env('true', v))).toEqual(['sms'])
    }
    expect(channelsOff(seq('email', 'email'), env('true'))).toEqual([])
    expect(channelsOff(seq('sms', 'sms'), env(undefined, 'true'))).toEqual([])
  })

  it('a mixed sequence needs both', () => {
    expect(channelsOff(seq('mixed', 'email', 'sms'), env('true', 'true'))).toEqual([])
    expect(channelsOff(seq('mixed', 'email', 'sms'), env('true'))).toEqual(['sms'])
    expect(channelsOff(seq('mixed', 'email', 'sms'), env(undefined, 'true'))).toEqual(['email'])
    expect(channelsOff(seq('mixed', 'email', 'sms'), env())).toEqual(['email', 'sms'])
  })

  it('a channel the CRM cannot send is always off', () => {
    expect(channelsOff(seq('email', 'voice'), env('true', 'true'))).toEqual(['voice'])
  })
})

describe('enrollBlockedReason', () => {
  it('says which switch is off, in one plain line', () => {
    expect(enrollBlockedReason(seq('email', 'email'), env())).toBe("Email is off, so this sequence can't start.")
    expect(enrollBlockedReason(seq('sms', 'sms'), env('true'))).toBe("Texting is off, so this sequence can't start.")
    expect(enrollBlockedReason(seq('mixed', 'email', 'sms'), env())).toBe(
      "Email and texting are off, so this sequence can't start.",
    )
    expect(enrollBlockedReason(seq('email', 'voice'), env('true', 'true'))).toBe(
      "This sequence uses a channel the CRM can't send, so it can't start.",
    )
  })

  it('is null when every channel the sequence uses is on', () => {
    expect(enrollBlockedReason(seq('email', 'email'), env('true'))).toBeNull()
    expect(enrollBlockedReason(seq('sms', 'sms'), env(undefined, 'true'))).toBeNull()
    expect(enrollBlockedReason(seq('mixed', 'email', 'sms'), env('true', 'true'))).toBeNull()
  })
})

describe('assertSequenceCanStart', () => {
  it('throws SequenceChannelOffError naming the channels that are off', () => {
    let err: unknown
    try {
      assertSequenceCanStart(seq('mixed', 'email', 'sms'), env('true'))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SequenceChannelOffError)
    expect(err).toMatchObject({
      code: 'sequence_channel_off',
      channels: ['sms'],
      message: "Texting is off, so this sequence can't start.",
    })
  })

  it('returns quietly when every channel is on', () => {
    expect(() => assertSequenceCanStart(seq('mixed', 'email', 'sms'), env('true', 'true'))).not.toThrow()
  })
})

describe('sequenceChannelOffResponse (both enrollment routes)', () => {
  it('is a 403 with the code, the plain message and the channels that are off', async () => {
    const res = sequenceChannelOffResponse(new SequenceChannelOffError(['sms'], "Texting is off, so this sequence can't start."))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: 'sequence_channel_off',
      message: "Texting is off, so this sequence can't start.",
      channels: ['sms'],
    })
  })
})

describe('sequencesOffReason ("Add to sequence" greyed out)', () => {
  it('while email and texting are both off, gives the one-line reason', () => {
    expect(SEQUENCES_OFF_REASON).toBe("Email and texting are off, so sequences can't start.")
    for (const e of OFF) for (const s of OFF) expect(sequencesOffReason(env(e, s))).toBe(SEQUENCES_OFF_REASON)
  })

  it('is null once either is on (a sequence on that channel could start; the server checks each one)', () => {
    expect(sequencesOffReason(env('true'))).toBeNull()
    expect(sequencesOffReason(env(undefined, 'true'))).toBeNull()
    expect(sequencesOffReason(env('true', 'true'))).toBeNull()
  })
})

describe('enrolledWhileOffBanner', () => {
  const tail = 'enrolled in sequences. Nothing sends while email and texting are off. Review them before switching either on.'

  it('N = 0: no banner', () => {
    expect(enrolledWhileOffBanner(0, env())).toBeNull()
  })

  it('N = 1: "1 person is"', () => {
    expect(enrolledWhileOffBanner(1, env())).toBe(`1 person is ${tail}`)
  })

  it('N = 3: "3 people are"', () => {
    expect(enrolledWhileOffBanner(3, env())).toBe(`3 people are ${tail}`)
    expect(enrolledWhileOffBanner(1200, env())).toBe(`1200 people are ${tail}`)
  })

  it('only while both switches are off, since that is what it says', () => {
    expect(enrolledWhileOffBanner(3, env('true'))).toBeNull()
    expect(enrolledWhileOffBanner(3, env(undefined, 'true'))).toBeNull()
    expect(enrolledWhileOffBanner(3, env('TRUE', '1'))).toBe(`3 people are ${tail}`)
  })

  it('never shows a nonsense count', () => {
    for (const n of [-1, Number.NaN]) expect(enrolledWhileOffBanner(n, env())).toBeNull()
  })
})
