import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { planPhoneBackfill, type PhoneBackfillPlan, type StoredDncRow, type StoredPhoneRow } from './phoneBackfill'

// Brief 41.1 (PR F): running the phone backfill (scripts/brief41-canonical-phones.ts)
// safely on the live CRM. The plan itself is phoneBackfill.ts.
//
// - Before anything is written, a private before-image (table, id, old phone,
//   new phone) is saved OUTSIDE any git checkout (it holds phone numbers; it's
//   never committed). `--restore <file>` puts those old values back.
// - `--apply` needs `--expect <n>`, the count from the dry run Ryan approved; a
//   different count refuses (something changed since).
// - Each row is written only if it still holds the phone the plan saw
//   (updateMany on id AND old phone), so a row changed meanwhile is skipped and
//   reported instead of overwritten.
// - Nothing printed carries a phone number: counts, row ids and file paths only.

export type BackfillTable = 'DncSuppression' | 'ContactPhone'
const TABLES: readonly BackfillTable[] = ['DncSuppression', 'ContactPhone']

export interface BackfillWrite {
  table: BackfillTable
  id: string
  oldPhone: string
  newPhone: string
}

export function backfillWrites(plan: PhoneBackfillPlan, dncRows: StoredDncRow[], phoneRows: StoredPhoneRow[]): BackfillWrite[] {
  const oldDnc = new Map(dncRows.map((r) => [r.id, r.phone]))
  const oldContact = new Map(phoneRows.map((r) => [r.id, r.phone]))
  const write = (table: BackfillTable, old: Map<string, string>) => (r: { id: string; phone: string }): BackfillWrite => {
    const oldPhone = old.get(r.id)
    if (oldPhone === undefined) throw new Error(`backfill plan names ${table} ${r.id}, which wasn't read`)
    return { table, id: r.id, oldPhone, newPhone: r.phone }
  }
  return [...plan.dnc.rewrite.map(write('DncSuppression', oldDnc)), ...plan.contactPhones.rewrite.map(write('ContactPhone', oldContact))]
}

type UpdateMany = (args: { where: { id: string; phone: string }; data: { phone: string } }) => Promise<{ count: number }>
type FindMany<T> = (args: any) => Promise<T[]>

export interface BackfillDb {
  dncSuppression: { findMany: FindMany<StoredDncRow>; updateMany: UpdateMany }
  contactPhone: { findMany: FindMany<StoredPhoneRow>; updateMany: UpdateMany }
}

const model = (db: BackfillDb, table: BackfillTable) => (table === 'DncSuppression' ? db.dncSuppression : db.contactPhone)

export interface ApplyResult {
  rewritten: number
  notHoldingExpected: string[] // "<table>:<id>": didn't hold the phone expected (changed since, or never rewritten); left alone
  conflicts: string[] // "<table>:<id>": a row with the target phone appeared meanwhile; left alone
}

// A run that stopped partway (a dropped connection, say): how far it got.
export class BackfillInterrupted extends Error {
  constructor(readonly done: number, readonly total: number, readonly partial: ApplyResult, readonly cause: unknown) {
    super(`stopped after ${done} of ${total} row(s): ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

const isUniqueViolation = (err: unknown) => (err as { code?: unknown } | null)?.code === 'P2002'
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

// One row at a time, each only if it still holds the phone expected. Every
// field is checked first: Prisma drops an undefined filter silently, which
// would turn this into an unconditional write.
export async function applyBackfillWrites(db: BackfillDb, writes: BackfillWrite[], onProgress?: (done: number) => void): Promise<ApplyResult> {
  const result: ApplyResult = { rewritten: 0, notHoldingExpected: [], conflicts: [] }
  for (const [i, w] of writes.entries()) {
    if (!TABLES.includes(w.table) || !nonEmpty(w.id) || !nonEmpty(w.oldPhone) || !nonEmpty(w.newPhone)) {
      throw new BackfillInterrupted(i, writes.length, result, new Error(`row ${i} is malformed; nothing written for it`))
    }
    try {
      const { count } = await model(db, w.table).updateMany({ where: { id: w.id, phone: w.oldPhone }, data: { phone: w.newPhone } })
      if (count === 1) result.rewritten++
      else if (count === 0) result.notHoldingExpected.push(`${w.table}:${w.id}`)
      else throw new Error(`${w.table}:${w.id} matched ${count} rows`)
    } catch (err) {
      if (isUniqueViolation(err)) result.conflicts.push(`${w.table}:${w.id}`)
      else throw new BackfillInterrupted(i, writes.length, result, err)
    }
    if ((i + 1) % 200 === 0) onProgress?.(i + 1)
  }
  return result
}

export interface PreImage {
  script: 'brief41-canonical-phones'
  createdAt: string
  database: string | null
  rows: BackfillWrite[]
}

// The deepest existing folder at or above `p`, with symlinks resolved.
function realExisting(p: string): string {
  let cur = path.resolve(p)
  const rest: string[] = []
  while (!existsSync(cur)) {
    rest.unshift(path.basename(cur))
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return path.join(realpathSync(cur), ...rest)
}

// Inside `root` (or equal to it), compared on real paths and, as on macOS's
// usual disks, ignoring case.
function isInside(dir: string, root: string): boolean {
  const rel = path.relative(realExisting(root).toLowerCase(), realExisting(dir).toLowerCase())
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

// The nearest folder at or above `dir` that is a git checkout, if any.
function gitCheckoutOf(dir: string): string | null {
  let cur = realExisting(dir)
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

// The before-image holds phone numbers: it never goes inside the repo or any
// other git checkout, never overwrites a file, and is private (0600; a new
// folder is 0700).
export function writePreImage(dir: string, preImage: PreImage, repoRoot: string): string {
  const abs = path.resolve(dir)
  const checkout = isInside(abs, repoRoot) ? repoRoot : gitCheckoutOf(abs)
  if (checkout) {
    throw new Error(`REFUSING: the before-image holds phone numbers, so it must be saved outside any git checkout (${abs} is inside ${checkout})`)
  }
  mkdirSync(abs, { recursive: true, mode: 0o700 })
  const file = path.join(abs, `brief41-canonical-phones-preimage-${preImage.createdAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(preImage, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return file
}

// Reads a before-image and refuses the whole file unless every row is sound.
// Errors name a row index, never a value (the file holds phone numbers).
export function readPreImage(file: string): PreImage {
  let parsed: PreImage
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as PreImage
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code) throw err // missing/unreadable: no file content in the message
    throw new Error(`REFUSING: ${file} is not valid JSON`)
  }
  if (parsed?.script !== 'brief41-canonical-phones' || !Array.isArray(parsed.rows)) {
    throw new Error(`REFUSING: ${file} is not a brief41-canonical-phones before-image`)
  }
  const seen = new Set<string>()
  parsed.rows.forEach((r, i) => {
    const ok = r && TABLES.includes(r.table) && nonEmpty(r.id) && nonEmpty(r.oldPhone) && nonEmpty(r.newPhone) && r.oldPhone !== r.newPhone
    if (!ok) throw new Error(`REFUSING: ${file} row ${i} is malformed (it needs table, id, oldPhone and newPhone); nothing was restored`)
    const key = `${r.table}:${r.id}`
    if (seen.has(key)) throw new Error(`REFUSING: ${file} row ${i} repeats ${key}; nothing was restored`)
    seen.add(key)
  })
  return parsed
}

// Restoring = the same conditional writes, new phone back to old.
export const restoreWrites = (preImage: PreImage): BackfillWrite[] =>
  preImage.rows.map((w) => ({ ...w, oldPhone: w.newPhone, newPhone: w.oldPhone }))

// The writes whose row still holds the phone they expect (read-only).
async function stillExpected(db: BackfillDb, writes: BackfillWrite[]): Promise<BackfillWrite[]> {
  const holds = new Set<string>()
  for (const table of TABLES) {
    const ids = writes.filter((w) => w.table === table).map((w) => w.id)
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await model(db, table).findMany({ where: { id: { in: ids.slice(i, i + 1000) } }, select: { id: true, phone: true } })
      for (const r of rows) holds.add(`${table}:${r.id}:${r.phone}`)
    }
  }
  return writes.filter((w) => holds.has(`${w.table}:${w.id}:${w.oldPhone}`))
}

export interface RunOptions {
  db: BackfillDb
  args: string[] // the script's arguments, without --i-mean-live
  log: (line: string) => void
  database: string | null // the target database's name (recorded in the before-image)
  repoRoot: string
  defaultPreImageDir: string
  now?: () => Date
}

const VALUED = new Set(['--expect', '--restore', '--preimage-dir'])
const SWITCHES = new Set(['--apply'])

// Only known flags, each at most once; valued flags need a value.
function parseArgs(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!VALUED.has(a) && !SWITCHES.has(a)) throw new Error(`REFUSING: unknown argument "${a}" (known: --apply, --expect <n>, --restore <file>, --preimage-dir <dir>, --i-mean-live)`)
    if (flags.has(a)) throw new Error(`REFUSING: ${a} given twice`)
    if (SWITCHES.has(a)) {
      flags.set(a, true)
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`REFUSING: ${a} needs a value`)
    flags.set(a, value)
    i++
  }
  return flags
}

function expectedCount(flags: Map<string, string | true>): number | undefined {
  const raw = flags.get('--expect')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error(`REFUSING: --expect needs a whole number (got "${raw}")`)
  return Number(raw)
}

function checkExpected(expected: number | undefined, actual: number, what: string): void {
  if (expected === undefined) {
    throw new Error(`REFUSING: --apply needs --expect <n>, the ${what} count from the dry run Ryan approved (it is ${actual} now).`)
  }
  if (expected !== actual) {
    throw new Error(`REFUSING: expected ${expected} ${what}, but there are ${actual} now. Something changed since the dry run: re-run it and check the new count with Ryan.`)
  }
}

const LIVE_HINT = '(plus --i-mean-live on the live CRM)'

// The whole run: dry run by default; --apply --expect n writes; --restore <file> undoes.
export async function runPhoneBackfill(opts: RunOptions): Promise<void> {
  const { db, log } = opts
  const flags = parseArgs(opts.args)
  const apply = flags.has('--apply')
  const expected = expectedCount(flags)

  const restoreFile = flags.get('--restore')
  if (typeof restoreFile === 'string') {
    const preImage = readPreImage(restoreFile)
    if (preImage.database !== opts.database) {
      throw new Error(`REFUSING: ${restoreFile} was taken from database "${preImage.database}", not "${opts.database}".`)
    }
    const writes = await stillExpected(db, restoreWrites(preImage))
    log(JSON.stringify({ restore: restoreFile, rowsInFile: preImage.rows.length, rowsToRestore: writes.length, changedSinceOrNeverRewritten: preImage.rows.length - writes.length }, null, 2))
    if (!apply) {
      log(`Dry run: nothing changed. To put the old values back: --restore ${restoreFile} --apply --expect ${writes.length} ${LIVE_HINT}.`)
      return
    }
    checkExpected(expected, writes.length, 'rows to restore')
    const result = await applyReporting(db, writes, log, () => [`To finish: run this restore's dry run again and apply its new count.`])
    log(JSON.stringify({ restored: result.rewritten, notHoldingTheNewValue: result.notHoldingExpected, conflicts: result.conflicts }, null, 2))
    log(`Restored ${result.rewritten} row(s) to their old value.`)
    return
  }

  const dncRows = await db.dncSuppression.findMany({ select: { id: true, organizationId: true, source: true, phone: true } })
  const phoneRows = await db.contactPhone.findMany({ select: { id: true, contactId: true, phone: true } })
  const plan = planPhoneBackfill(dncRows, phoneRows)
  const writes = backfillWrites(plan, dncRows, phoneRows)
  log(JSON.stringify({
    optOutRows: dncRows.length,
    optOutsToRewrite: plan.dnc.rewrite.length,
    optOutsAlreadyCoveredByACanonicalRow: plan.dnc.alreadyCovered.length,
    optOutsNotAPhoneNumber: plan.dnc.unparseable,
    contactPhoneRows: phoneRows.length,
    contactPhonesToRewrite: plan.contactPhones.rewrite.length,
    contactPhonesAlreadyCoveredOnTheirContact: plan.contactPhones.alreadyCovered.length,
    contactPhonesNotAPhoneNumber: plan.contactPhones.unparseable,
    rowsToRewrite: writes.length,
  }, null, 2))

  if (!apply) {
    log(`Dry run: nothing changed. To rewrite them: --apply --expect ${writes.length} ${LIVE_HINT}.`)
    return
  }
  checkExpected(expected, writes.length, 'rows to rewrite')
  const file = writePreImage(
    (flags.get('--preimage-dir') as string | undefined) ?? opts.defaultPreImageDir,
    { script: 'brief41-canonical-phones', createdAt: (opts.now?.() ?? new Date()).toISOString(), database: opts.database, rows: writes },
    opts.repoRoot,
  )
  log(`Before-image saved (private, outside the repo): ${file}`)
  const result = await applyReporting(db, writes, log, () => [
    `To finish: run the dry run again and apply its new count (that saves a second before-image).`,
    `To undo what was written: --restore ${file} (dry run first), and likewise for any later before-image.`,
  ])
  log(JSON.stringify({ rewritten: result.rewritten, changedSinceDryRun: result.notHoldingExpected, conflicts: result.conflicts }, null, 2))
  log(`Rewrote ${result.rewritten} row(s) to canonical E.164. To undo: --restore ${file} (dry run first).`)
}

// Applies the writes; if it stops partway, says how far it got and what to do.
async function applyReporting(
  db: BackfillDb,
  writes: BackfillWrite[],
  log: (line: string) => void,
  recovery: () => string[],
): Promise<ApplyResult> {
  try {
    return await applyBackfillWrites(db, writes, (n) => log(`… ${n} of ${writes.length}`))
  } catch (err) {
    if (err instanceof BackfillInterrupted) {
      log(`STOPPED PARTWAY: ${err.done} of ${err.total} row(s) handled before the error.`)
      log(JSON.stringify({ written: err.partial.rewritten, notHoldingExpected: err.partial.notHoldingExpected, conflicts: err.partial.conflicts }, null, 2))
      for (const line of recovery()) log(line)
    }
    throw err
  }
}
