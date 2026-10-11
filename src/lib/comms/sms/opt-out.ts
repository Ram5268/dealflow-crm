/**
 * Brief 41.1 (F5): which inbound texts are opt-outs. Pure (no I/O), so the
 * webhook, the lost-STOP sweep (scripts/brief41-1-stop-sweep.ts) and later the
 * inbox all read a message the same way.
 *
 * The text is lowercased, apostrophes dropped ("don't" → "dont"), every other
 * punctuation mark turned into a space and spaces collapsed, so "STOP!",
 * "stop." and "Opt-Out" all read as keywords. The set includes the FCC's 2024
 * revocation words (stop, quit, end, revoke, opt out, cancel, unsubscribe).
 *
 * - 'keyword': the whole message is one of them.
 * - 'phrase': a longer message contains one as whole words ("please stop
 *   texting me"). That's an opt-out too: treating a maybe as an opt-out is the
 *   safe side, even though "can you stop by Tuesday?" then counts. It's marked
 *   separately so the inbox can show these for review.
 */
export function normalizeSmsText(body: string): string {
  return body
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export const OPT_OUT_PHRASES: readonly string[] = [
  ...new Set(
    [
      'stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke',
      'opt out', 'optout', 'opt-out', 'remove me', 'do not text', "don't text",
    ].map(normalizeSmsText),
  ),
]

export interface OptOutMatch {
  kind: 'keyword' | 'phrase'
  phrase: string // the keyword or phrase that matched, normalized
}

export function classifyOptOut(body: string | null | undefined): OptOutMatch | null {
  const text = normalizeSmsText(body ?? '')
  if (!text) return null
  if (OPT_OUT_PHRASES.includes(text)) return { kind: 'keyword', phrase: text }
  const padded = ` ${text} `
  const phrase = OPT_OUT_PHRASES.find((p) => padded.includes(` ${p} `))
  return phrase ? { kind: 'phrase', phrase } : null
}
