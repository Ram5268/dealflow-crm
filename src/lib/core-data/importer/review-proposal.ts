// Brief 50 PR 6 (open item 6.6; audit L23/L5): what the review screen starts
// from. Before this, an AI answer that couldn't be read ended in "Map the
// columns manually to continue", pointing to a screen that didn't exist, and
// an AI outage ended in "retry". Now the screen always opens:
//   - 'ai': the AI's proposal, as before;
//   - 'manual': the AI couldn't be read or reached, so every column starts on
//     "Don't import" (with its real sample values) and Ryan picks each field;
//   - 'last-run': "Back to the import" after a stopped or stuck run shows the
//     mapping that run committed, with Ryan's own changes, instead of a fresh
//     AI guess that would quietly undo them (and couldn't continue the run).
import { ZodError } from 'zod'
import {
  mappingProposalSchema,
  proposeMapping,
  type AnthropicCaller,
  type ExistingCustomField,
  type MappingProposal,
  type ProposeMappingResult,
} from './ai-mapping'
import { sampleValues, type ParsedFile } from './parser'

export type ProposalSource = 'ai' | 'manual' | 'last-run'

export interface ReviewProposal extends ProposeMappingResult {
  source: ProposalSource
  /** Plain English for the top of the screen; null for the AI's own proposal. */
  notice: string | null
  /** Why the AI's answer wasn't used (for the logs), when source is 'manual'. */
  error?: unknown
}

export const AI_UNREADABLE_NOTICE =
  "The AI's suggested mapping couldn't be read, so every column starts on \"Don't import\". Choose each column's field below."
export const AI_UNAVAILABLE_NOTICE =
  "The AI couldn't suggest a mapping just now, so every column starts on \"Don't import\". Choose each column's field below, or reload the page to ask the AI again."
export const LAST_RUN_NOTICE =
  'These are the columns as you last committed them, including any you changed. Check them and commit again.'

/** A mapping saved on the import, if it still reads as one (the run's bookkeeping dropped). */
export function savedProposal(mappingJson: unknown): MappingProposal | null {
  const parsed = mappingProposalSchema.safeParse(mappingJson)
  return parsed.success ? parsed.data : null
}

/** Every column on "Don't import", with its sample values. */
export function manualProposal(parsed: ParsedFile): ProposeMappingResult {
  return {
    mapping: parsed.headerRow.map((column) => ({
      column,
      sampleValues: sampleValues(parsed.sampleRows, column, 5),
      target: { kind: 'ignore' as const },
      confidence: 0,
      reasoning: '',
    })),
    likelyDuplicates: [],
    coercedColumns: [],
  }
}

export async function proposalForReview(input: {
  parsed: ParsedFile
  existing: ExistingCustomField[]
  caller: AnthropicCaller
  /** The mapping a stopped run committed (route: a failed or stuck import). */
  saved: MappingProposal | null
}): Promise<ReviewProposal> {
  if (input.saved) return { ...input.saved, coercedColumns: [], source: 'last-run', notice: LAST_RUN_NOTICE }
  try {
    return { ...(await proposeMapping(input.parsed, input.existing, input.caller)), source: 'ai', notice: null }
  } catch (error) {
    // A ZodError is an answer that couldn't be read even after repair; asking
    // again usually gives the same. Anything else (no key, an outage) may pass.
    const notice = error instanceof ZodError ? AI_UNREADABLE_NOTICE : AI_UNAVAILABLE_NOTICE
    return { ...manualProposal(input.parsed), source: 'manual', notice, error }
  }
}
