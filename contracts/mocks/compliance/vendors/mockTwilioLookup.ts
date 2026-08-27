import type { LineTypeResult } from '../../../../src/lib/compliance/mobileLine/twilioLookup'

// Deterministic mock Twilio Lookup for isolation/tests. A phone is a mobile
// unless listed as a landline/voip override.
export function makeMockTwilioLookup(overrides: Map<string, string> = new Map()) {
  return async (phone: string): Promise<LineTypeResult> => ({
    lineType: overrides.get(phone) ?? 'mobile',
    carrier: 'MockCarrier',
  })
}

export const mockTwilioLookup = makeMockTwilioLookup()
