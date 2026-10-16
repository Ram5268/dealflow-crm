import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { emit as defaultEmit } from '@/lib/core-data/events/emit'
import { getObject } from './storage'
import { parseFile } from './parser'
import { normalizePhoneE164, normalizePhoneType, dedupKey } from './dedup'
import { buildCustomValueColumns } from '@/lib/core-data/leads/custom-values'
import { normalizeStreet, sameStreet } from './address'
import {
  heldBy,
  importRunOf,
  mappingKey,
  newRunId,
  resumePoint,
  sameMappingJson,
  withImportRun,
  type ResumeState,
} from './batch'
import { PLACEHOLDER_NAME, isRealName, leadRealNames, namesConflict } from './names'
import type { MappingProposal, ColumnMapping } from './ai-mapping'

// ─────────────────────────────────────────────────────────────────────────────
// Import commit worker (brief §9 Milestone 6). Applies a confirmed column
// mapping to every row: creates custom-field definitions for new columns, then
// upserts Lead + Contact + phones/emails + custom values, dedups, emits
// `lead.upserted-from-import` (channel crm_lead_sync, NO eventName), and stamps
// Lead.source = "import:" + importBatchId on every upsert (locked A-side
// commitment for C's bulk-scrub). buildRowPlan is pure and unit-tested.
//
// Brief 41 (H4, M25): a merge never blanks a value or replaces a Mojo ID;
// only a confirmed same property (same Mojo ID, or same street) may change a
// name, address, status or custom value, otherwise a merge only fills blanks; a
// row that is another property becomes a new lead; rows that could be the same
// lead run one after another; a failed or timed-out commit is marked 'failed';
// a completed batch never re-runs.
//
// Brief 41.1 (F1, F10): a run only writes its batch while it holds the claim
// (its run id), so a stopped run can never reopen or overwrite a newer run; a
// phone match whose names disagree is a different person; a row whose event
// fails is counted once.
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
  customValues: Array<{ column: string; definitionId: string; type: string; raw: string }>
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
    .map((c) => ({ column: c.column, definitionId: c.definitionId, type: c.type, raw: row[c.column] }))

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
    PLACEHOLDER_NAME

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

// Rows that could resolve to the same lead (same Mojo ID, any shared phone, or
// the same name + street) are grouped so they import one after another: two
// rows for one owner can no longer both miss each other and both create. Groups
// keep file order; different owners run concurrently.
export function groupRowsByIdentity(plans: RowPlan[]): number[][] {
  const parent = plans.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const firstRowWithKey = new Map<string, number>()
  plans.forEach((plan, i) => {
    const named = !!(plan.lead.name || plan.contact.name || plan.lead.primaryAddressFull)
    const keys = [
      plan.lead.mojoId ? `mojo:${plan.lead.mojoId}` : null,
      ...plan.phones.map((p) => `phone:${p.phoneE164}`),
      named ? `na:${plan.displayName.toLowerCase()}|${normalizeStreet(plan.lead.primaryAddressFull?.split(',')[0]) ?? ''}` : null,
    ]
    for (const key of keys) {
      if (!key) continue
      const j = firstRowWithKey.get(key)
      if (j === undefined) {
        firstRowWithKey.set(key, i)
        continue
      }
      const a = find(i)
      const b = find(j)
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  })
  const groups = new Map<number, number[]>()
  plans.forEach((_, i) => {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(i)
    else groups.set(root, [i])
  })
  return [...groups.values()]
}

// Ensure custom-field definitions exist for every new_custom_field / existing
// column; returns columnName → { definitionId, type }.
async function ensureCustomFieldDefinitions(
  db: PrismaClient,
  organizationId: string,
  mapping: ColumnMapping[]
): Promise<Array<{ column: string; definitionId: string; type: string }>> {
  const out: Array<{ column: string; definitionId: string; type: string }> = []
  let order = 0
  const maxOrder = await db.customFieldDefinition.aggregate({
    where: { organizationId, objectType: 'lead' },
    _max: { displayOrder: true },
  })
  order = (maxOrder._max.displayOrder ?? -1) + 1

  for (const col of mapping) {
    if (col.target.kind === 'new_custom_field') {
      const def = await db.customFieldDefinition.upsert({
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
      const def = await db.customFieldDefinition.findFirst({
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
  // Defaults to the app's client; tests point it at the perf DB.
  db?: PrismaClient
  // Tests inject a clock and a short limit for the time-limit path.
  now?: () => number
  timeLimitMs?: number
  watchdogMs?: number
  // The run claimImportCommit started (Brief 41.1). The commit only works on,
  // and only writes, a batch that run still holds. Without one (tests, a
  // direct call) the commit takes the batch itself, unless a claimed run
  // holds it.
  runId?: string
}

export interface CommitResult {
  totalRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  errorRows: number
}

// The commit runs in after() under the route's maxDuration (300 s). It stops
// starting rows well before that, so it can always mark the batch 'failed'
// with a reason instead of being killed mid-way and left at 'importing'.
export const COMMIT_TIME_LIMIT_MS = 240_000
// Fires only if a single query hangs past the time limit.
export const COMMIT_WATCHDOG_MS = 270_000
const PROGRESS_EVERY = 100

// Why a run stopped starting rows: the time limit, the watchdog, or a write
// that found the import no longer this run's.
type StopReason = 'time' | 'watchdog' | 'lost'

// A run that stopped before every row: carries where a re-run with the same
// mapping continues.
class ImportStopped extends Error {
  constructor(reason: StopReason, doneRows: number, totalRows: number, readonly resume: ResumeState) {
    super(
      reason === 'time'
        ? `time limit reached after ${doneRows} of ${totalRows} rows. ` +
            'Run it again to continue from there; rows already imported are not repeated or duplicated'
        : reason === 'watchdog'
          ? `the import stopped responding after ${doneRows} of ${totalRows} rows. ` +
            'Run it again to continue from there; rows already imported are not repeated or duplicated'
          : `this run stopped after ${doneRows} of ${totalRows} rows: the import was marked stopped or taken over by a newer run. ` +
            'Run it again to continue from there; rows already imported are not repeated or duplicated'
    )
  }
}

// Full commit path. Reads the raw file, resolves the mapping, and upserts every
// row. A completed batch is never imported twice: a retry or a second run
// returns the counts the first run recorded. Any failure, including running
// out of time, marks the batch 'failed' (with the reason) before rethrowing.
// Running it again is safe: after a time-limit stop it continues where it
// stopped; otherwise rows already imported are merged, not duplicated.
//
// Brief 41.1 (F1): the run works on, and writes, its batch only while it holds
// the claim (deps.runId, from claimImportCommit). Every write is an UPDATE
// whose WHERE requires the batch to still be this run's, so a run that stopped
// responding can never mark a newer run's import failed (which let a third run
// start beside it and import the same homeowners twice), overwrite its counts
// or complete it. Once the watchdog fires, or a write finds the import gone to
// a newer run, this run starts no more rows.
export async function commitImport(
  importBatchId: string,
  duplicateStrategy: DuplicateStrategy,
  mapping: MappingProposal,
  correlationId: string,
  deps: CommitDeps = {}
): Promise<CommitResult> {
  const emit = deps.emit ?? defaultEmit
  const db = deps.db ?? prisma
  const now = deps.now ?? Date.now
  const startedAt = now()
  const timeLimitMs = deps.timeLimitMs ?? COMMIT_TIME_LIMIT_MS
  const watchdogMs = deps.watchdogMs ?? COMMIT_WATCHDOG_MS
  const source = `import:${importBatchId}`
  const key = mappingKey(mapping)
  const runId = deps.runId ?? newRunId()

  const result: CommitResult = {
    totalRows: 0,
    importedRows: 0,
    duplicateRows: 0,
    skippedRows: 0,
    errorRows: 0,
  }
  const errorLog: Array<{ row: number; message: string }> = []
  // Lands only while this run holds the batch in one of `statuses`.
  const writeHeld = async (data: Prisma.ImportBatchUpdateManyMutationInput, statuses: string[]): Promise<boolean> => {
    const { count } = await db.importBatch.updateMany({ where: heldBy(importBatchId, runId, statuses), data })
    return count === 1
  }
  // The run's heartbeat: an import with none for 10 minutes has no live run.
  const beat = () => withImportRun(mapping, { id: runId, beatAt: new Date().toISOString() })
  // 'failed' with the reason and where a re-run continues. The watchdog's
  // write is marked (a re-run waits a minute: this run may still be finishing
  // a row) and lands only while the run is importing. The run's own late
  // failure may replace its watchdog failure, being more exact, but never
  // touches a newer run.
  const markFailed = (message: string, resume: ResumeState | undefined, byWatchdog = false) =>
    writeHeld(
      {
        status: 'failed',
        ...counts(result),
        errorLog: [
          ...errorLog.slice(0, 499),
          {
            row: 0,
            message: `Import stopped: ${message}`,
            ...(resume ? { resume: { next: resume.next, partial: resume.partial }, mappingKey: key } : {}),
            ...(byWatchdog ? { watchdog: true } : {}),
          },
        ],
        completedAt: new Date(),
      },
      byWatchdog ? ['importing'] : ['importing', 'failed']
    ).catch(() => false) // the original error is what the caller needs
  let settled = false
  let stopped: StopReason | null = null
  // Where a re-run would continue, as of now; the watchdog records it.
  let resumeNow: () => ResumeState | undefined = () => undefined
  // In case one query hangs (the file download, a row) past the time limit:
  // mark the batch failed before the platform kills the function, and start no
  // more rows. Armed before any work. If the rows already started then finish
  // every row, the run's own 'completed' write comes later and wins.
  const watchdog = setTimeout(() => {
    if (settled) return
    stopped = 'watchdog'
    void markFailed('the import stopped responding. Run it again to continue', resumeNow(), true)
  }, watchdogMs)
  watchdog.unref?.()

  try {
    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: importBatchId } })
    if (batch.status === 'completed') return counts(batch)
    const holder = batch.status === 'importing' ? importRunOf(batch.mappingJson)?.id : undefined
    if (deps.runId) {
      // Not this run's import (any more): a newer run holds it, or this run's
      // watchdog already marked it failed. Do nothing.
      if (holder !== deps.runId) return counts(batch)
    } else {
      // A direct call (tests, scripts) never runs beside a claimed run; it
      // takes the batch itself, if nothing changed since it was read.
      if (holder) throw new Error('this import is held by a run that was claimed for it; commit it through claimImportCommit')
      const { count } = await db.importBatch.updateMany({
        where: { id: importBatchId, status: batch.status, completedAt: batch.completedAt, mappingJson: sameMappingJson(batch.mappingJson) },
        data: { status: 'importing', mappingJson: beat() },
      })
      if (count === 0) throw new Error('the import changed while it was starting; run it again')
    }
    const organizationId = batch.organizationId

    // A re-run after a stop continues where that run stopped (the grouping is
    // the same for the same file and mapping), keeping its counts and errors.
    const prior = resumePoint(batch.errorLog, key)
    if (prior) {
      result.totalRows = batch.totalRows
      result.importedRows = batch.importedRows
      result.duplicateRows = batch.duplicateRows
      result.skippedRows = batch.skippedRows
      result.errorRows = batch.errorRows
      for (const e of Array.isArray(batch.errorLog) ? batch.errorLog : []) {
        if (e && typeof e === 'object' && (e as { row?: unknown }).row !== 0) errorLog.push(e as { row: number; message: string })
      }
      resumeNow = () => prior
    }

    const buffer = await getObject(batch.storageKey, db)
    const parsed = parseFile(buffer, batch.filename)
    const customColumns = await ensureCustomFieldDefinitions(db, organizationId, mapping.mapping)
    const resolved = resolveMapping(mapping.mapping, customColumns)
    const plans = parsed.allRows.map((row) => buildRowPlan(row, resolved))
    const groups = groupRowsByIdentity(plans)
    result.totalRows = plans.length

    // Rows already done in each group: all of a group before prior.next, or
    // the recorded part of a group that was cut off.
    const done = groups.map((g, gi) => (prior && gi < prior.next ? g.length : 0))
    for (const [gi, rows] of prior?.partial ?? []) if (gi < groups.length) done[gi] = Math.min(rows, groups[gi].length)
    // Groups start in index order, so every group that has done any work comes
    // before every group that hasn't. Those cut off mid-way are listed.
    resumeNow = () => {
      let next = groups.length
      while (next > 0 && done[next - 1] === 0) next--
      const partial: Array<[number, number]> = []
      for (let gi = 0; gi < next; gi++) if (done[gi] < groups[gi].length) partial.push([gi, done[gi]])
      return { next, partial }
    }
    if (!(await writeHeld({ totalRows: result.totalRows, mappingJson: beat() }, ['importing']))) stopped ??= 'lost'

    // Counts and a heartbeat are written every PROGRESS_EVERY rows so the
    // progress page moves.
    let processed = done.reduce((n, d) => n + d, 0)
    let reported = processed
    const reportProgress = async () => {
      if (processed - reported < PROGRESS_EVERY) return
      reported = processed
      // Best-effort; the final write is authoritative. Refused means the
      // import is no longer this run's (or its watchdog fired): stop.
      const held = await writeHeld({ ...counts(result), mappingJson: beat() }, ['importing']).catch(() => true)
      if (!held) stopped ??= 'lost'
    }

    // Some row was not started (time limit, watchdog or lost claim).
    let cutShort = false
    // `counted` marks the row done in its group the moment it is counted, so a
    // stop while its event is still being sent never redoes (and recounts) it.
    const importRow = async (i: number, counted: () => void): Promise<boolean> => {
      if (stopped || now() - startedAt > timeLimitMs) {
        stopped ??= 'time'
        cutShort = true
        return false
      }
      const plan = plans[i]
      const rowErrors = (message: string) => errorLog.push({ row: i + 2, message })
      if (!plan.lead.mojoId && plan.phones.length === 0 && !plan.lead.name && !plan.contact.name && !plan.lead.primaryAddressFull) {
        // Nothing to match it on: it would merge into every other such row.
        result.errorRows++
        counted()
        rowErrors('no Mojo ID, phone, name or address to identify this row; skipped')
      } else {
        let leadId: string | null = null
        try {
          const outcome = await upsertRow(db, organizationId, source, plan, duplicateStrategy, rowErrors)
          if (outcome === 'skipped') {
            result.skippedRows++
            counted()
          } else {
            result.importedRows++
            if (outcome.merged) result.duplicateRows++
            counted()
            leadId = outcome.leadId
          }
        } catch (err) {
          result.errorRows++
          counted()
          rowErrors(err instanceof Error ? err.message : String(err))
        }
        // Brief 41.1: the row is counted once, as imported (its lead is
        // written), even if its event fails; that failure is listed instead
        // of counting the row again as an error (progress went past 100%).
        if (leadId) {
          try {
            await emit('crm_lead_sync', { leadId, sourceLabel: batch.sourceLabel, importBatchId, correlationId })
          } catch (err) {
            rowErrors(`imported, but its sync event failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (plan.phones.some((p) => p.nonstandard)) rowErrors('nonstandard phone type kept as-is')
      }
      processed++
      await reportProgress()
      return true
    }

    // Rows are processed with bounded concurrency: sequential .create over the
    // Railway network is ~90ms/row, so 1k rows serially blows past any budget.
    // Rows that could be the same lead share a group and run in file order.
    const CONCURRENCY = 25
    await mapWithConcurrency(groups, CONCURRENCY, async (group, gi) => {
      for (let r = done[gi]; r < group.length; r++) {
        const markDone = () => { done[gi] = r + 1 }
        if (!(await importRow(group[r], markDone))) return
        markDone()
      }
    })
    if (cutShort) throw new ImportStopped(stopped ?? 'time', processed, result.totalRows, resumeNow() ?? { next: 0, partial: [] })

    settled = true
    // Every row is done. This may replace the run's own watchdog failure (the
    // work did finish), never a newer run's state.
    await writeHeld(
      { status: 'completed', ...counts(result), errorLog: errorLog.slice(0, 500), completedAt: new Date() },
      ['importing', 'failed']
    )
    return result
  } catch (err) {
    settled = true
    await markFailed(err instanceof Error ? err.message : String(err), err instanceof ImportStopped ? err.resume : resumeNow())
    throw err
  } finally {
    settled = true
    clearTimeout(watchdog)
  }
}

function counts(r: CommitResult) {
  return {
    totalRows: r.totalRows,
    importedRows: r.importedRows,
    duplicateRows: r.duplicateRows,
    skippedRows: r.skippedRows,
    errorRows: r.errorRows,
  }
}

interface UpsertOk {
  leadId: string
  merged: boolean
}

// What a merge knows about the lead it matched.
interface LeadMatch {
  id: string
  mojoId: string | null
  name: string | null
  displayName: string
  primaryAddressFull: string | null
  statusLabel: string | null
  // true when the row is certainly this property (same Mojo ID, or same street):
  // only then may it change a name, status or custom value.
  sameProperty: boolean
  // how it matched: only a Mojo ID match may rewrite an existing address (a
  // same-street match already has it, often more completely).
  by: 'mojo' | 'street' | 'other'
}

// Returns the affected leadId + whether it merged into an existing lead, or
// 'skipped'. Kept as its own function so commitImport stays readable.
async function upsertRow(
  db: PrismaClient,
  organizationId: string,
  source: string,
  plan: RowPlan,
  strategy: DuplicateStrategy,
  rowErrors: (message: string) => void
): Promise<'skipped' | UpsertOk> {
  const existing = await findExistingLead(db, organizationId, plan)

  if (existing && strategy === 'skip') return 'skipped'
  if (!existing || strategy === 'add-anyway') return createLead(db, organizationId, source, plan, rowErrors)

  // Merge path. A Mojo ID only fills a blank, and atomically: if another row
  // filled this lead first, the lead is another property, so this row is too.
  if (plan.lead.mojoId && !existing.mojoId) {
    const { count } = await db.lead.updateMany({
      where: { id: existing.id, mojoId: null },
      data: { mojoId: plan.lead.mojoId },
    })
    if (count === 0) return createLead(db, organizationId, source, plan, rowErrors)
  }
  await db.lead.update({ where: { id: existing.id }, data: mergeUpdate(plan, source, existing) })
  const leadId = existing.id

  // Reuse its primary contact, dedup phones.
  let contact = await db.contact.findFirst({
    where: { leadId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (!contact) {
    contact = await db.contact.create({
      data: {
        organizationId, leadId,
        displayName: plan.contact.name ?? plan.displayName,
        name: plan.contact.name ?? null,
        title: plan.contact.title ?? null,
      },
    })
  }
  if (plan.phones.length) {
    await db.contactPhone.createMany({
      data: plan.phones.map((p, idx) => ({ contactId: contact!.id, phone: p.phoneE164, type: p.type, isPrimary: idx === 0 })),
      skipDuplicates: true,
    })
  }
  if (plan.emails.length) {
    await db.contactEmail.createMany({
      data: plan.emails.map((e, idx) => ({ contactId: contact!.id, email: e, type: 'work', isPrimary: idx === 0 })),
      skipDuplicates: true,
    })
  }
  await writeCustomValues(db, organizationId, leadId, plan.customValues, existing.sameProperty ? 'overwrite' : 'fill', rowErrors)
  return { leadId, merged: true }
}

// A brand-new lead is created with its contact + phones + emails nested in a
// SINGLE query (no contact lookup — there is nothing to reuse yet).
async function createLead(
  db: PrismaClient,
  organizationId: string,
  source: string,
  plan: RowPlan,
  rowErrors: (message: string) => void
): Promise<UpsertOk> {
  const lead = await db.lead.create({
    data: {
      organizationId,
      displayName: plan.displayName,
      name: plan.lead.name ?? null,
      primaryAddressFull: plan.lead.primaryAddressFull ?? null,
      primaryAddressSummary: plan.lead.primaryAddressFull?.split(',')[0] ?? null,
      statusLabel: plan.lead.statusLabel ?? null,
      mojoId: plan.lead.mojoId ?? null,
      source,
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
  await writeCustomValues(db, organizationId, lead.id, plan.customValues, 'fill', rowErrors)
  return { leadId: lead.id, merged: false }
}

// Brief 41 (H4): a merge writes only the fields the file actually has, and a
// blank cell never wipes a value. Only a confirmed same property may change an
// existing name or status, and only a Mojo ID match may rewrite an address;
// otherwise the row only fills blanks. The name only changes from a Lead.name
// column (a co-owner never replaces it). The Mojo ID is handled separately
// (fill-only, atomically) in upsertRow.
function mergeUpdate(plan: RowPlan, source: string, existing: LeadMatch): Prisma.LeadUpdateInput {
  const data: Prisma.LeadUpdateInput = { source }
  const may = (current: string | null) => existing.sameProperty || !current
  // A lead created by hand (or with the name in Contact.name) has a real
  // displayName but no Lead.name: that counts as a name to keep. "Imported
  // Lead", the address, the Mojo ID or a list placeholder ("Current
  // Resident") standing in for a name don't, and a placeholder in the file
  // never replaces a name.
  const leadContext = { address: existing.primaryAddressFull, mojoId: existing.mojoId }
  const shownName = [existing.name, existing.displayName].find((n) => !!n && isRealName(n, leadContext)) ?? null
  const rowName = plan.lead.name && isRealName(plan.lead.name, { address: plan.lead.primaryAddressFull, mojoId: plan.lead.mojoId }) ? plan.lead.name : null
  if (rowName && may(shownName)) {
    data.name = plan.lead.name
    data.displayName = plan.displayName
  }
  if (plan.lead.primaryAddressFull && (existing.by === 'mojo' || !existing.primaryAddressFull)) {
    data.primaryAddressFull = plan.lead.primaryAddressFull
    data.primaryAddressSummary = plan.lead.primaryAddressFull.split(',')[0]
  }
  if (plan.lead.statusLabel && may(existing.statusLabel)) data.statusLabel = plan.lead.statusLabel
  return data
}

// Custom values in one or two statements (not one upsert per column). A cell
// that doesn't parse for its field type (e.g. "N/A" in a number field) is
// skipped and logged, never written as a blank. 'overwrite' replaces the lead's
// values for these fields; 'fill' only adds the ones it doesn't have yet.
async function writeCustomValues(
  db: PrismaClient,
  organizationId: string,
  leadId: string,
  values: RowPlan['customValues'],
  mode: 'overwrite' | 'fill',
  rowErrors: (message: string) => void
): Promise<void> {
  const data: Prisma.CustomFieldValueCreateManyInput[] = []
  for (const cv of values) {
    const cols = buildCustomValueColumns(cv.type, cv.raw)
    if (cols.valueText == null && cols.valueNumber == null && cols.valueDate == null && cols.valueJson === undefined) {
      rowErrors(`column "${cv.column}": "${cv.raw}" isn't a valid ${cv.type}; kept the lead's existing value`)
      continue
    }
    data.push({ organizationId, definitionId: cv.definitionId, objectType: 'lead', objectId: leadId, ...cols } as Prisma.CustomFieldValueCreateManyInput)
  }
  if (data.length === 0) return
  if (mode === 'fill') {
    await db.customFieldValue.createMany({ data, skipDuplicates: true })
    return
  }
  await db.$transaction([
    db.customFieldValue.deleteMany({ where: { objectId: leadId, definitionId: { in: data.map((d) => d.definitionId) } } }),
    db.customFieldValue.createMany({ data }),
  ])
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

// Brief 41 (H4): matching a row to an existing lead.
//  1. Same Mojo ID → that lead (the same property).
//  2. Else the leads sharing the row's first phone, oldest first, skipping any
//     with a different Mojo ID (another property of the same owner):
//       - the row has an address: the lead at the same street (same property),
//         else a lead with no address yet (the row fills it in); otherwise the
//         row is another property and becomes a new lead;
//       - the row has no address: the first such lead. A row with a Mojo ID
//         never attaches it to a lead whose address it can't confirm.
//  3. Else the exact name + address. With no address that's the name alone,
//     so only a phoneless row with a real name may use it, and a row with a
//     Mojo ID never does.
// No match → a new lead.
//
// Brief 41.1 (F10): in step 2, a lead whose real names (owner, hand-typed
// name, contacts) all differ from the row's real names is another person who
// shares the phone, so it is skipped like another property. Names are compared
// forgivingly ("OWNER, Alice Q." is "Alice Owner"); a row or lead with no real
// name (a phone-only list, "Imported Lead") never conflicts.
async function findExistingLead(
  db: PrismaClient,
  organizationId: string,
  plan: RowPlan
): Promise<LeadMatch | null> {
  const select = { id: true, mojoId: true, name: true, displayName: true, primaryAddressFull: true, statusLabel: true } as const
  const rowAddress = plan.lead.primaryAddressFull ?? null
  if (plan.lead.mojoId) {
    const byMojo = await db.lead.findFirst({ where: { organizationId, mojoId: plan.lead.mojoId }, select })
    if (byMojo) return { ...byMojo, sameProperty: true, by: 'mojo' }
  }
  const otherProperty = (l: { mojoId: string | null }) => !!(plan.lead.mojoId && l.mojoId && l.mojoId !== plan.lead.mojoId)

  if (plan.phones[0]) {
    const rowNames = [plan.lead.name, plan.contact.name].filter(
      (n): n is string => !!n && isRealName(n, { address: rowAddress, mojoId: plan.lead.mojoId })
    )
    const candidates = (
      await db.lead.findMany({
        where: { organizationId, contacts: { some: { phones: { some: { phone: plan.phones[0].phoneE164 } } } } },
        select: { ...select, contacts: { select: { name: true, displayName: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25,
      })
    ).filter((l) => !otherProperty(l) && !namesConflict(rowNames, leadRealNames(l)))
    if (rowAddress) {
      const same = candidates.find((l) => sameStreet(l.primaryAddressFull, rowAddress))
      if (same) return { ...same, sameProperty: true, by: 'street' }
      const blank = candidates.find((l) => !l.primaryAddressFull)
      if (blank) return { ...blank, sameProperty: false, by: 'other' }
    } else {
      const usable = candidates.find((l) => !(plan.lead.mojoId && !l.mojoId && l.primaryAddressFull))
      if (usable) return { ...usable, sameProperty: false, by: 'other' }
    }
    // Leads with this phone are other properties: try the exact name + address.
  }

  // Exact name + address. Without an address that is a match on the name alone,
  // so only a phoneless row with a real name may use it: a row with a new phone
  // number is a new lead, never "another lead with the same name" (and never
  // the "Imported Lead" placeholder).
  const realName = !!(plan.lead.name || plan.contact.name)
  if (!rowAddress && (plan.phones[0] || !realName)) return null
  const byNameAddr = await db.lead.findFirst({
    where: {
      organizationId,
      displayName: plan.displayName,
      primaryAddressFull: rowAddress,
    },
    select,
  })
  if (byNameAddr && !otherProperty(byNameAddr) && !(plan.lead.mojoId && !byNameAddr.mojoId && !rowAddress)) {
    return { ...byNameAddr, sameProperty: !!rowAddress, by: rowAddress ? 'street' : 'other' }
  }
  return null
}
