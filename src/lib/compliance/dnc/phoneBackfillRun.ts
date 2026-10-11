import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { planPhoneBackfill, type PhoneBackfillPlan, type StoredDncRow, type StoredPhoneRow } from './phoneBackfill'

// Brief 41.1 (PR F): running the phone backfill (scripts/brief41-canonical-phones.ts)
// safely on the live CRM. The plan itself is phoneBackfill.ts.
//
// - Before anything is written, a private before-image (table, id, old phone,
//   new phone) is saved OUTSIDE the repos (it holds phone numbers; it's never
//   committed). `--restore <file>` puts those old values back.
// - `--apply` needs `--expect <n>`, the count from the dry run Ryan approved; a
//   different count refuses (something changed since).
// - Each row is written only if it still holds the phone the plan saw
//   (updateMany on id AND old phone), so a row changed meanwhile is skipped and
//   reported instead of overwritten.

export type BackfillTable = 'DncSuppression' | 'ContactPhone'

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

export interface BackfillDb {
  dncSuppression: { findMany: (args: any) => Promise<StoredDncRow[]>; updateMany: UpdateMany }
  contactPhone: { findMany: (args: any) => Promise<StoredPhoneRow[]>; updateMany: UpdateMany }
}

export interface ApplyResult {
  rewritten: number
  changedMeanwhile: string[] // "<table>:<id>": no longer held the old phone; left alone
  conflicts: string[] // "<table>:<id>": a row with the new phone appeared meanwhile; left alone
}

const isUniqueViolation = (err: unknown) => (err as { code?: unknown } | null)?.code === 'P2002'

// One row at a time, each only if it still holds its old phone.
export async function applyBackfillWrites(db: BackfillDb, writes: BackfillWrite[], onProgress?: (done: number) => void): Promise<ApplyResult> {
  const result: ApplyResult = { rewritten: 0, changedMeanwhile: [], conflicts: [] }
  for (const [i, w] of writes.entries()) {
    const model = w.table === 'DncSuppression' ? db.dncSuppression : db.contactPhone
    try {
      const { count } = await model.updateMany({ where: { id: w.id, phone: w.oldPhone }, data: { phone: w.newPhone } })
      if (count === 1) result.rewritten++
      else result.changedMeanwhile.push(`${w.table}:${w.id}`)
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      result.conflicts.push(`${w.table}:${w.id}`)
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

// The before-image goes outside the repo (it holds phone numbers): refuses a
// directory inside `repoRoot`, never overwrites a file, and is private (0600).
export function writePreImage(dir: string, preImage: PreImage, repoRoot: string): string {
  const abs = path.resolve(dir)
  const rel = path.relative(path.resolve(repoRoot), abs)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`REFUSING: the before-image holds phone numbers, so it must be saved outside the repo (got ${abs})`)
  }
  mkdirSync(abs, { recursive: true, mode: 0o700 })
  const file = path.join(abs, `brief41-canonical-phones-preimage-${preImage.createdAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(preImage, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return file
}

export function readPreImage(file: string): PreImage {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as PreImage
  if (parsed?.script !== 'brief41-canonical-phones' || !Array.isArray(parsed.rows)) {
    throw new Error(`${file} is not a brief41-canonical-phones before-image`)
  }
  return parsed
}

// Restoring = the same conditional writes, new phone back to old.
export const restoreWrites = (preImage: PreImage): BackfillWrite[] =>
  preImage.rows.map((w) => ({ ...w, oldPhone: w.newPhone, newPhone: w.oldPhone }))

export interface RunOptions {
  db: BackfillDb
  args: string[] // the script's arguments, without --i-mean-live
  log: (line: string) => void
  database: string | null // the target database's name (recorded in the before-image)
  repoRoot: string
  defaultPreImageDir: string
  now?: () => Date
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

function expectedCount(args: string[]): number | undefined {
  const raw = flagValue(args, '--expect')
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new Error(`--expect needs a whole number (got "${raw}")`)
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

const summary = (r: ApplyResult) =>
  JSON.stringify({ rewritten: r.rewritten, changedMeanwhile: r.changedMeanwhile, conflicts: r.conflicts }, null, 2)

// The whole run: dry run by default; --apply [--expect n] writes; --restore <file> undoes.
export async function runPhoneBackfill(opts: RunOptions): Promise<void> {
  const { db, args, log } = opts
  const apply = args.includes('--apply')
  const expected = expectedCount(args)

  const restoreFile = flagValue(args, '--restore')
  if (restoreFile) {
    const writes = restoreWrites(readPreImage(restoreFile))
    log(JSON.stringify({ restore: restoreFile, rowsToRestore: writes.length }, null, 2))
    if (!apply) {
      log(`Dry run: nothing changed. Re-run with --apply --expect ${writes.length} to put the old values back.`)
      return
    }
    checkExpected(expected, writes.length, 'rows to restore')
    const result = await applyBackfillWrites(db, writes, (n) => log(`… ${n} of ${writes.length}`))
    log(summary(result))
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
    log(`Dry run: nothing changed. To rewrite them: --apply --expect ${writes.length} (plus --i-mean-live on the live CRM).`)
    return
  }
  checkExpected(expected, writes.length, 'rows to rewrite')
  const file = writePreImage(
    flagValue(args, '--preimage-dir') ?? opts.defaultPreImageDir,
    { script: 'brief41-canonical-phones', createdAt: (opts.now?.() ?? new Date()).toISOString(), database: opts.database, rows: writes },
    opts.repoRoot,
  )
  log(`Before-image saved (private, outside the repo): ${file}`)
  const result = await applyBackfillWrites(db, writes, (n) => log(`… ${n} of ${writes.length}`))
  log(summary(result))
  log(`Rewrote ${result.rewritten} row(s) to canonical E.164. To undo: --restore ${file} (dry run first).`)
}
