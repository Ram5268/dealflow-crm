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

TARGET SHAPES. The value of target.kind MUST be exactly one of these four literals —
"custom_field", "new_custom", and "standard" are NOT valid and will be rejected:
- {"kind":"standard_field","field":"<one of the standard fields above>"}
- {"kind":"new_custom_field","name":"<label>","type":"text|number|date|datetime|url|email|choices","choices":[...]}
- {"kind":"existing_custom_field","definitionId":"<id from existingCustomFields>"}
- {"kind":"ignore"}

If a column does not fit any standard field, propose a NEW custom field using
kind:"new_custom_field":
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

/** A `target.kind` the model produced that is not in the discriminated union. */
export interface CoercedColumn {
  column: string
  /** What the model actually said. */
  from: string
  /** What we rewrote it to. */
  to: MappingTarget['kind']
}

export interface RepairResult {
  raw: unknown
  coerced: CoercedColumn[]
}

const VALID_KINDS = new Set(['standard_field', 'new_custom_field', 'existing_custom_field', 'ignore'])

// Near-misses seen from the model. `custom_field` is the one that broke the
// live import (M6): the payload was a perfectly good new_custom_field, only the
// discriminator was wrong.
const KIND_ALIASES: Record<string, MappingTarget['kind']> = {
  custom_field: 'new_custom_field',
  new_custom: 'new_custom_field',
  custom: 'new_custom_field',
  newcustomfield: 'new_custom_field',
  existing_custom: 'existing_custom_field',
  existing: 'existing_custom_field',
  standard: 'standard_field',
  field: 'standard_field',
  skip: 'ignore',
  none: 'ignore',
}

/**
 * Infer the intended variant from the payload's own keys. Deliberately runs
 * AFTER the alias table and BEFORE giving up: a target carrying `name` + `type`
 * is unambiguously a new custom field whatever the model called it, and
 * discarding it would silently drop one of Ryan's columns.
 */
function inferKindFromShape(target: Record<string, unknown>): MappingTarget['kind'] | null {
  if (typeof target.definitionId === 'string') return 'existing_custom_field'
  if (typeof target.field === 'string' && (STANDARD_FIELDS as readonly string[]).includes(target.field)) {
    return 'standard_field'
  }
  if (typeof target.name === 'string' && typeof target.type === 'string') return 'new_custom_field'
  return null
}

/**
 * Rewrite out-of-enum `target.kind` values in place of failing the whole
 * response.
 *
 * Before this, ONE unrecognised kind in one column threw a ZodError out of
 * `proposeMapping`, the route answered 503, and a five-column CSV could not be
 * imported at all. Coercion is ordered most- to least-informed:
 *   1. alias table  2. payload shape  3. `ignore`
 * `ignore` is the last resort, not the first: it is the only outcome that
 * silently loses a column.
 */
export function repairMappingKinds(raw: unknown): RepairResult {
  const coerced: CoercedColumn[] = []
  if (typeof raw !== 'object' || raw === null) return { raw, coerced }

  const root = raw as Record<string, unknown>
  if (!Array.isArray(root.mapping)) return { raw, coerced }

  for (const entry of root.mapping) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const target = e.target
    if (typeof target !== 'object' || target === null) continue

    const t = target as Record<string, unknown>
    const kind = t.kind
    if (typeof kind === 'string' && VALID_KINDS.has(kind)) continue

    const from = typeof kind === 'string' ? kind : JSON.stringify(kind ?? null)
    const normalized = typeof kind === 'string' ? kind.toLowerCase().replace(/[\s-]/g, '_') : ''
    const to = KIND_ALIASES[normalized] ?? inferKindFromShape(t) ?? 'ignore'

    t.kind = to
    // A coerced target must still satisfy its variant. Anything the model left
    // out is filled with the safest value rather than failing the parse.
    if (to === 'new_custom_field') {
      if (typeof t.name !== 'string') t.name = String(e.column ?? 'Untitled column')
      if (typeof t.type !== 'string') t.type = 'text'
    }
    if (to === 'ignore') {
      delete t.field
      delete t.name
      delete t.type
      delete t.choices
      delete t.definitionId
    }

    coerced.push({ column: String(e.column ?? '(unknown column)'), from, to })
  }

  return { raw: root, coerced }
}

export interface ProposeMappingResult extends MappingProposal {
  /** Columns whose `kind` the model got wrong and we rewrote. Empty on a clean
   *  response. Surfaced to the UI so a silent rewrite is never invisible. */
  coercedColumns: CoercedColumn[]
}

/** Appended to the prompt on the single retry, so the model sees its own error. */
export function buildRetryPrompt(user: string, issue: string): string {
  return `${user}\n\nYOUR PREVIOUS RESPONSE WAS REJECTED: ${issue}\nEvery target.kind must be exactly one of "standard_field", "new_custom_field", "existing_custom_field", "ignore". Return corrected JSON only.`
}

export async function proposeMapping(
  parsed: ParsedFile,
  existing: ExistingCustomField[],
  caller: AnthropicCaller
): Promise<ProposeMappingResult> {
  const user = buildUserPrompt(parsed, existing)

  const attempt = async (prompt: string): Promise<ProposeMappingResult> => {
    const text = await caller(MAPPING_SYSTEM_PROMPT, prompt)
    const { raw, coerced } = repairMappingKinds(extractJson(text))
    const parsedProposal = mappingProposalSchema.parse(raw)
    return { ...parsedProposal, coercedColumns: coerced }
  }

  const first = await attempt(user)

  // Every single column coerced means the model misunderstood the contract
  // rather than fumbling one token — worth one retry with the error fed back.
  // A partial coercion is a good result and is NOT retried: it costs a second
  // API call to improve a mapping Ryan is about to review by hand anyway.
  const allCoerced = first.mapping.length > 0 && first.coercedColumns.length === first.mapping.length
  if (!allCoerced) return first

  try {
    return await attempt(
      buildRetryPrompt(user, `every column used an invalid target.kind (e.g. "${first.coercedColumns[0].from}")`)
    )
  } catch {
    // The retry is best-effort: the coerced first response is still usable.
    return first
  }
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
