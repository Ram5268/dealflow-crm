import { prisma } from '@/lib/prisma'
import { emit as defaultEmit } from '@/lib/core-data/events/emit'
import { getObject } from './storage'
import { parseFile } from './parser'
import { normalizePhoneE164, normalizePhoneType, dedupKey } from './dedup'
import { buildCustomValueColumns } from '@/lib/core-data/leads/custom-values'
import type { MappingProposal, ColumnMapping } from './ai-mapping'

// ─────────────────────────────────────────────────────────────────────────────
// Import commit worker (brief §9 Milestone 6). Applies a confirmed column
// mapping to every row: creates custom-field definitions for new columns, then
// upserts Lead + Contact + phones/emails + custom values, dedups, emits
// `lead.upserted-from-import` (channel crm_lead_sync, NO eventName), and stamps
// Lead.source = "import:" + importBatchId on every upsert (locked A-side
// commitment for C's bulk-scrub). buildRowPlan is pure and unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

export type DuplicateStrategy = 'skip' | 'merge' | 'add-anyway'

// Column → resolved target, split by kind for row planning.
export interface ResolvedMapping {
  leadName?: string
  leadAddress?: string
  leadMojoId?: string
  leadStatus?: string
  contactName?: string
  contactTitle?: string
  phoneColumns: string[]
  phoneTypeColumn?: string
  emailColumns: string[]
  // columnName → definitionId + type (for custom values)
  customColumns: Array<{ column: string; definitionId: string; type: string }>
}

const STANDARD_TO_SLOT: Record<string, keyof ResolvedMapping | 'phone' | 'email'> = {
  'Lead.name': 'leadName',
  'Lead.primaryAddressFull': 'leadAddress',
  'Lead.mojoId': 'leadMojoId',
  'Lead.statusLabel': 'leadStatus',
  'Contact.name': 'contactName',
  'Contact.title': 'contactTitle',
  'ContactPhone.phone': 'phone',
  'ContactPhone.type': 'phoneTypeColumn',
  'ContactEmail.email': 'email',
}

export interface RowPlan {
  displayName: string
  lead: { name?: string; primaryAddressFull?: string; mojoId?: string; statusLabel?: string }
  contact: { name?: string; title?: string }
  phones: Array<{ phoneE164: string; type: string; nonstandard: boolean }>
  emails: string[]
  customValues: Array<{ definitionId: string; type: string; raw: string }>
  dedup: ReturnType<typeof dedupKey>
}

// Collapses internal runs of whitespace; returns '' for nullish so the
// displayName fallback chain treats blank-ish values as absent.
function collapseWs(v: string | undefined | null): string {
  return (v ?? '').replace(/\s+/g, ' ').trim()
}

// Pure row → plan. No DB. Drops phones/emails that don't normalize.
export function buildRowPlan(row: Record<string, string>, m: ResolvedMapping): RowPlan {
  const lead = {
    name: m.leadName ? row[m.leadName]?.trim() || undefined : undefined,
    primaryAddressFull: m.leadAddress ? row[m.leadAddress]?.trim() || undefined : undefined,
    mojoId: m.leadMojoId ? row[m.leadMojoId]?.trim() || undefined : undefined,
    statusLabel: m.leadStatus ? row[m.leadStatus]?.trim() || undefined : undefined,
  }
  const contact = {
    name: m.contactName ? row[m.contactName]?.trim() || undefined : undefined,
    title: m.contactTitle ? row[m.contactTitle]?.trim() || undefined : undefined,
  }
  const rawType = m.phoneTypeColumn ? row[m.phoneTypeColumn] : undefined
  const typeNorm = normalizePhoneType(rawType)
  const phones: RowPlan['phones'] = []
  for (const col of m.phoneColumns) {
    const e164 = normalizePhoneE164(row[col])
    if (e164 && !phones.some((p) => p.phoneE164 === e164)) {
      phones.push({ phoneE164: e164, type: typeNorm.type, nonstandard: typeNorm.nonstandard })
    }
  }
  const emails: string[] = []
  for (const col of m.emailColumns) {
    const v = row[col]?.trim().toLowerCase()
    if (v && v.includes('@') && !emails.includes(v)) emails.push(v)
  }
  const customValues = m.customColumns
    .filter((c) => (row[c.column] ?? '').trim() !== '')
    .map((c) => ({ definitionId: c.definitionId, type: c.type, raw: row[c.column] }))

  // Lead.name comes from Mojo's "Full Name" (the primary owner). Contact.name is
  // mapped from Mojo's "Second Name" — the CO-OWNER. Letting contact.name win
  // made the co-owner the headline name everywhere displayName is rendered
  // (lead detail, leads list, queue, dialer ammunition panel), so Ryan would
  // greet the wrong person on a cold call. Lead.name must outrank it.
  const displayName =
    collapseWs(lead.name) ||
    collapseWs(contact.name) ||
    collapseWs(lead.primaryAddressFull) ||
    collapseWs(lead.mojoId) ||
    'Imported Lead'

  return {
    displayName,
    lead,
    contact,
    phones,
    emails,
    customValues,
    dedup: dedupKey({ phoneE164: phones[0]?.phoneE164 ?? null, name: displayName, addressFull: lead.primaryAddressFull }),
  }
}

// Ensure custom-field definitions exist for every new_custom_field / existing
// column; returns columnName → { definitionId, type }.
async function ensureCustomFieldDefinitions(
  organizationId: string,
  mapping: ColumnMapping[]
): Promise<Array<{ column: string; definitionId: string; type: string }>> {
  const out: Array<{ column: string; definitionId: string; type: string }> = []
  let order = 0
  const maxOrder = await prisma.customFieldDefinition.aggregate({
    where: { organizationId, objectType: 'lead' },
    _max: { displayOrder: true },
  })
  order = (maxOrder._max.displayOrder ?? -1) + 1

  for (const col of mapping) {
    if (col.target.kind === 'new_custom_field') {
      const def = await prisma.customFieldDefinition.upsert({
        where: {
          organizationId_objectType_name: {
            organizationId,
            objectType: 'lead',
            name: col.target.name,
          },
        },
        create: {
          organizationId,
          objectType: 'lead',
          name: col.target.name,
          type: col.target.type,
          choices: col.target.choices ?? [],
          displayOrder: order++,
        },
        update: {},
      })
      out.push({ column: col.column, definitionId: def.id, type: def.type })
    } else if (col.target.kind === 'existing_custom_field') {
      const def = await prisma.customFieldDefinition.findFirst({
        where: { id: col.target.definitionId, organizationId },
      })
      if (def) out.push({ column: col.column, definitionId: def.id, type: def.type })
    }
  }
  return out
}

export function resolveMapping(
  mapping: ColumnMapping[],
  customColumns: Array<{ column: string; definitionId: string; type: string }>
): ResolvedMapping {
  const r: ResolvedMapping = { phoneColumns: [], emailColumns: [], customColumns }
  for (const col of mapping) {
    if (col.target.kind !== 'standard_field') continue
    const slot = STANDARD_TO_SLOT[col.target.field]
    if (slot === 'phone') r.phoneColumns.push(col.column)
    else if (slot === 'email') r.emailColumns.push(col.column)
    else if (slot === 'phoneTypeColumn') r.phoneTypeColumn = col.column
    else if (slot) (r as unknown as Record<string, string>)[slot] = col.column
  }
  return r
}

export interface CommitDeps {
  emit?: typeof defaultEmit
}

export interface CommitResult {
  totalRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  errorRows: number
}

// Full commit path. Reads the raw file, resolves the mapping, and upserts every
// row. Idempotent: re-running the same file with the same batch converges (mojoId
// unique, phone dedup, custom-value upsert).
export async function commitImport(
  importBatchId: string,
  duplicateStrategy: DuplicateStrategy,
  mapping: MappingProposal,
  correlationId: string,
  deps: CommitDeps = {}
): Promise<CommitResult> {
  const emit = deps.emit ?? defaultEmit
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: importBatchId } })
  const organizationId = batch.organizationId
  const source = `import:${importBatchId}`

  const buffer = await getObject(batch.storageKey)
  const parsed = parseFile(buffer, batch.filename)
  const customColumns = await ensureCustomFieldDefinitions(organizationId, mapping.mapping)
  const resolved = resolveMapping(mapping.mapping, customColumns)

  const result: CommitResult = {
    totalRows: parsed.allRows.length,
    importedRows: 0,
    duplicateRows: 0,
    skippedRows: 0,
    errorRows: 0,
  }
  const errorLog: Array<{ row: number; message: string }> = []

  // Rows are processed with bounded concurrency: sequential .create over the
  // Railway network is ~90ms/row, so 1k rows serially blows past any budget.
  // A modest pool keeps wall-clock in check while the unique constraints
  // (Lead.mojoId, ContactPhone[contactId,phone]) still guard against races.
  const CONCURRENCY = 25
  await mapWithConcurrency(parsed.allRows, CONCURRENCY, async (row, i) => {
    const plan = buildRowPlan(row, resolved)
    try {
      const outcome = await upsertRow(organizationId, source, plan, duplicateStrategy)
      if (outcome === 'skipped') {
        result.skippedRows++
      } else {
        result.importedRows++
        if (outcome.merged) result.duplicateRows++
        await emit('crm_lead_sync', {
          leadId: outcome.leadId,
          sourceLabel: batch.sourceLabel,
          importBatchId,
          correlationId,
        })
      }
    } catch (err) {
      result.errorRows++
      errorLog.push({ row: i + 2, message: err instanceof Error ? err.message : String(err) })
    }
    if (plan.phones.some((p) => p.nonstandard)) {
      errorLog.push({ row: i + 2, message: 'nonstandard phone type kept as-is' })
    }
  })

  await prisma.importBatch.update({
    where: { id: importBatchId },
    data: {
      status: 'completed',
      totalRows: result.totalRows,
      importedRows: result.importedRows,
      duplicateRows: result.duplicateRows,
      skippedRows: result.skippedRows,
      errorRows: result.errorRows,
      errorLog: errorLog.slice(0, 500),
      completedAt: new Date(),
    },
  })
  return result
}

interface UpsertOk {
  leadId: string
  merged: boolean
}

// Returns the affected leadId + whether it merged into an existing lead, or
// 'skipped'. Kept as its own function so commitImport stays readable.
async function upsertRow(
  organizationId: string,
  source: string,
  plan: RowPlan,
  strategy: DuplicateStrategy
): Promise<'skipped' | UpsertOk> {
  const existing = await findExistingLead(organizationId, plan)

  if (existing && strategy === 'skip') return 'skipped'

  const leadData = {
    name: plan.lead.name ?? null,
    primaryAddressFull: plan.lead.primaryAddressFull ?? null,
    primaryAddressSummary: plan.lead.primaryAddressFull?.split(',')[0] ?? null,
    statusLabel: plan.lead.statusLabel ?? null,
    mojoId: plan.lead.mojoId ?? null,
    source,
  }

  // Fast path: a brand-new lead is created with its contact + phones + emails
  // nested in a SINGLE query (no contact lookup — there is nothing to reuse yet).
  if (!existing || strategy === 'add-anyway') {
    const lead = await prisma.lead.create({
      data: {
        organizationId,
        displayName: plan.displayName,
        ...leadData,
        contacts: {
          create: {
            organizationId,
            displayName: plan.contact.name ?? plan.displayName,
            name: plan.contact.name ?? null,
            title: plan.contact.title ?? null,
            phones: {
              create: plan.phones.map((p, idx) => ({ phone: p.phoneE164, type: p.type, isPrimary: idx === 0 })),
            },
            emails: {
              create: plan.emails.map((e, idx) => ({ email: e, type: 'work', isPrimary: idx === 0 })),
            },
          },
        },
      },
    })
    await writeCustomValues(organizationId, lead.id, plan.customValues)
    return { leadId: lead.id, merged: false }
  }

  // Merge path: update the existing lead, reuse its primary contact, dedup phones.
  await prisma.lead.update({ where: { id: existing }, data: { ...leadData, displayName: plan.displayName } })
  const leadId = existing
  let contact = await prisma.contact.findFirst({
    where: { leadId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        organizationId, leadId,
        displayName: plan.contact.name ?? plan.displayName,
        name: plan.contact.name ?? null,
        title: plan.contact.title ?? null,
      },
    })
  }
  if (plan.phones.length) {
    await prisma.contactPhone.createMany({
      data: plan.phones.map((p, idx) => ({ contactId: contact!.id, phone: p.phoneE164, type: p.type, isPrimary: idx === 0 })),
      skipDuplicates: true,
    })
  }
  if (plan.emails.length) {
    await prisma.contactEmail.createMany({
      data: plan.emails.map((e, idx) => ({ contactId: contact!.id, email: e, type: 'work', isPrimary: idx === 0 })),
      skipDuplicates: true,
    })
  }
  await writeCustomValues(organizationId, leadId, plan.customValues)
  return { leadId, merged: true }
}

async function writeCustomValues(
  organizationId: string,
  leadId: string,
  values: RowPlan['customValues']
): Promise<void> {
  for (const cv of values) {
    const cols = buildCustomValueColumns(cv.type, cv.raw)
    await prisma.customFieldValue.upsert({
      where: { definitionId_objectId: { definitionId: cv.definitionId, objectId: leadId } },
      create: { organizationId, definitionId: cv.definitionId, objectType: 'lead', objectId: leadId, ...cols },
      update: cols,
    })
  }
}

// Runs `fn` over items with at most `limit` concurrent in flight. Preserves the
// original index so error rows can be reported by line number.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) break
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

async function findExistingLead(organizationId: string, plan: RowPlan): Promise<string | null> {
  if (plan.lead.mojoId) {
    const byMojo = await prisma.lead.findFirst({
      where: { organizationId, mojoId: plan.lead.mojoId },
      select: { id: true },
    })
    if (byMojo) return byMojo.id
  }
  if (plan.phones[0]) {
    const byPhone = await prisma.contactPhone.findFirst({
      where: { phone: plan.phones[0].phoneE164, contact: { organizationId } },
      select: { contact: { select: { leadId: true } } },
    })
    if (byPhone) return byPhone.contact.leadId
  }
  if (plan.dedup.kind === 'name-address') {
    const byNameAddr = await prisma.lead.findFirst({
      where: {
        organizationId,
        displayName: plan.displayName,
        primaryAddressFull: plan.lead.primaryAddressFull ?? null,
      },
      select: { id: true },
    })
    if (byNameAddr) return byNameAddr.id
  }
  return null
}
