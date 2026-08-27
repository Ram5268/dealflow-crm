import { z } from 'zod'
import { sampleValues, type ParsedFile } from './parser'

// ─────────────────────────────────────────────────────────────────────────────
// AI column mapper. Claude Sonnet 4.6 (model id locked via the claude-api skill,
// 2026-08-27: `claude-sonnet-4-6`) proposes column→field mappings and flags
// unmapped columns as new custom fields. The Anthropic caller is injectable so
// unit tests exercise prompt shape + response parsing without a live key.
// ─────────────────────────────────────────────────────────────────────────────

export const MODEL_ID = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'

export const MAPPING_SYSTEM_PROMPT = `You are a CSV column mapper for a real-estate CRM. You will map spreadsheet columns to CRM fields.

STANDARD FIELDS (map to these when they fit):
- Lead.name (string)
- Lead.primaryAddressFull (string, full address in one line)
- Lead.mojoId (string, Mojo Dialer internal contact ID) — HIGH-VALUE, DETECT AGGRESSIVELY.
  Ryan's Mojo export column may be labeled "Contact ID", "Mojo ID", "MojoID", "ID",
  "Dialer ID", or similar. Prefer standard_field mapping to Lead.mojoId if the values
  look like short numeric or alphanumeric identifiers AND the header hints at "id".
  Missing this mapping breaks downstream signal sync — err on the side of mapping.
- Lead.statusLabel (string)
- Contact.name (string, human person name)
- Contact.title (string)
- ContactPhone.phone (E.164 phone number)
- ContactPhone.type (office|mobile|home|direct — post-normalized downstream; you may return synonyms)
- ContactEmail.email (email address)

If a column does not fit any standard field, propose a NEW custom field:
- name: human-readable label
- type: text | number | date | datetime | url | email | choices
- choices: only if type=choices AND column has <20 distinct values

If a column is ambiguous or garbage, return kind:"ignore".

RULES:
- NEVER hallucinate. If uncertain, use ignore with reasoning.
- Flag likely duplicate columns (e.g., "Phone" and "Phone Number").
- Confidence is 0-1. Below 0.5 = uncertain.

Output JSON only, matching the schema.`

const STANDARD_FIELDS = [
  'Lead.name',
  'Lead.primaryAddressFull',
  'Lead.mojoId',
  'Lead.statusLabel',
  'Contact.name',
  'Contact.title',
  'ContactPhone.phone',
  'ContactPhone.type',
  'ContactEmail.email',
] as const

export const mappingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standard_field'), field: z.enum(STANDARD_FIELDS) }),
  z.object({
    kind: z.literal('new_custom_field'),
    name: z.string(),
    type: z.enum(['text', 'number', 'date', 'datetime', 'url', 'email', 'choices']),
    choices: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('existing_custom_field'), definitionId: z.string() }),
  z.object({ kind: z.literal('ignore') }),
])
export type MappingTarget = z.infer<typeof mappingTargetSchema>

export const columnMappingSchema = z.object({
  column: z.string(),
  sampleValues: z.array(z.string()),
  target: mappingTargetSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})
export type ColumnMapping = z.infer<typeof columnMappingSchema>

export const mappingProposalSchema = z.object({
  mapping: z.array(columnMappingSchema),
  likelyDuplicates: z.array(
    z.object({ columnA: z.string(), columnB: z.string(), reason: z.string() })
  ),
})
export type MappingProposal = z.infer<typeof mappingProposalSchema>

export interface ExistingCustomField {
  definitionId: string
  name: string
  type: string
}

// The Anthropic caller returns the model's raw text. Injectable for tests.
export type AnthropicCaller = (system: string, user: string) => Promise<string>

export function buildUserPrompt(
  parsed: ParsedFile,
  existing: ExistingCustomField[]
): string {
  const perColumnSamples = parsed.headerRow.map((col) => ({
    column: col,
    samples: sampleValues(parsed.sampleRows, col, 5),
  }))
  return JSON.stringify(
    {
      instruction:
        'Map each column to a target. Return JSON: { "mapping": [{ column, sampleValues, target, confidence, reasoning }], "likelyDuplicates": [{ columnA, columnB, reason }] }',
      headerRow: parsed.headerRow,
      columnSamples: perColumnSamples,
      existingCustomFields: existing,
    },
    null,
    2
  )
}

function extractJson(text: string): unknown {
  // Tolerate fenced code blocks or leading prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response')
  return JSON.parse(candidate.slice(start, end + 1))
}

export async function proposeMapping(
  parsed: ParsedFile,
  existing: ExistingCustomField[],
  caller: AnthropicCaller
): Promise<MappingProposal> {
  const user = buildUserPrompt(parsed, existing)
  const text = await caller(MAPPING_SYSTEM_PROMPT, user)
  const raw = extractJson(text)
  return mappingProposalSchema.parse(raw)
}

// Default caller backed by the Anthropic SDK. One retry on transient error.
export function defaultAnthropicCaller(): AnthropicCaller {
  return async (system, user) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set')
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const doCall = async () => {
      const res = await client.messages.create({
        model: MODEL_ID,
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }],
      })
      const block = res.content.find((b) => b.type === 'text')
      if (!block || block.type !== 'text') throw new Error('No text block in AI response')
      return block.text
    }
    try {
      return await doCall()
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
      return doCall()
    }
  }
}
