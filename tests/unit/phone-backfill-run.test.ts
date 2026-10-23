import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { planPhoneBackfill } from '@/lib/compliance/dnc/phoneBackfill'
import { backfillWrites, readPreImage, runPhoneBackfill, type BackfillDb } from '@/lib/compliance/dnc/phoneBackfillRun'

// Brief 41.1 (PR F): the phone backfill on the live CRM keeps a private
// before-image, needs the approved dry-run count, and only writes rows that
// still hold the phone the dry run saw. An in-memory fake of the two tables.
type Row = { id: string; phone: string; organizationId?: string; source?: string; contactId?: string }

function fakeDb(dnc: Row[], phones: Row[], opts: { onUpdate?: (table: string, id: string, n: number) => void; matchAll?: boolean } = {}) {
  const tables = { DncSuppression: dnc, ContactPhone: phones }
  let n = 0
  const updateMany = (table: keyof typeof tables) =>
    vi.fn(async ({ where, data }: { where: { id: string; phone: string }; data: { phone: string } }) => {
      opts.onUpdate?.(table, where.id, ++n)
      if (opts.matchAll) return { count: 2 }
      const row = tables[table].find((r) => r.id === where.id && r.phone === where.phone)
      if (!row) return { count: 0 }
      const clash = tables[table].find((r) =>
        r !== row && r.phone === data.phone &&
        (table === 'DncSuppression' ? r.organizationId === row.organizationId && r.source === row.source : r.contactId === row.contactId))
      if (clash) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      row.phone = data.phone
      return { count: 1 }
    })
  const findMany = (rows: Row[]) =>
    vi.fn(async (args?: { where?: { id?: { in: string[] } } }) =>
      rows.filter((r) => !args?.where?.id || args.where.id.in.includes(r.id)).map((r) => ({ ...r })) as any)
  const db = {
    dncSuppression: { findMany: findMany(dnc), updateMany: updateMany('DncSuppression') },
    contactPhone: { findMany: findMany(phones), updateMany: updateMany('ContactPhone') },
  }
  return db as typeof db & BackfillDb
}

const opt = (id: string, phone: string, organizationId = 'o1', source = 'internal'): Row => ({ id, phone, organizationId, source })
const cp = (id: string, phone: string, contactId = 'c1'): Row => ({ id, phone, contactId })

let dir: string
let repo: string
let lines: string[]
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'b411-preimage-'))
  repo = mkdtempSync(path.join(tmpdir(), 'b411-repo-'))
  lines = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const run = (db: BackfillDb, args: string[], database: string | null = 'dealflow_crm_test') =>
  runPhoneBackfill({
    db, args, log: (l) => lines.push(l), database, repoRoot: repo,
    defaultPreImageDir: path.join(dir, 'private'), now: () => new Date('2026-10-11T12:00:00.000Z'),
  })
const preImages = () => (existsSync(path.join(dir, 'private')) ? readdirSync(path.join(dir, 'private')) : [])
const jsonLine = (key: string) => JSON.parse(lines.find((l) => l.includes(`"${key}"`))!)
const writePre = (rows: unknown, database: string | null = 'dealflow_crm_test') => {
  const file = path.join(dir, 'pre.json')
  writeFileSync(file, JSON.stringify({ script: 'brief41-canonical-phones', createdAt: 'x', database, rows }))
  return file
}

describe('phone backfill: before-image, --expect, conditional writes', () => {
  it('the writes carry each row old and new phone, opt-outs first', () => {
    const dnc = [opt('a', '9175550147'), opt('b', '+12125550101')]
    const phones = [cp('p1', '(718) 555-0102')]
    expect(backfillWrites(planPhoneBackfill(dnc as any, phones as any), dnc as any, phones as any)).toEqual([
      { table: 'DncSuppression', id: 'a', oldPhone: '9175550147', newPhone: '+19175550147' },
      { table: 'ContactPhone', id: 'p1', oldPhone: '(718) 555-0102', newPhone: '+17185550102' },
    ])
  })

  it('dry run: counts and the --expect to use; writes nothing, saves nothing', async () => {
    const db = fakeDb([opt('a', '9175550147')], [cp('p1', '718-555-0102'), cp('p2', 'call office')])
    await run(db, [])
    expect(JSON.parse(lines[0])).toMatchObject({ optOutsToRewrite: 1, contactPhonesToRewrite: 1, contactPhonesNotAPhoneNumber: ['p2'], rowsToRewrite: 2 })
    expect(lines.at(-1)).toContain('--apply --expect 2 (plus --i-mean-live on the live CRM)')
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
    expect(db.contactPhone.updateMany).not.toHaveBeenCalled()
    expect(preImages()).toEqual([])
  })

  it('--apply without --expect, or with a different count, refuses before writing or saving anything', async () => {
    const db = fakeDb([opt('a', '9175550147')], [cp('p1', '718-555-0102')])
    await expect(run(db, ['--apply'])).rejects.toThrow(/REFUSING: --apply needs --expect <n>.*it is 2 now/)
    await expect(run(db, ['--apply', '--expect', '3'])).rejects.toThrow(/REFUSING: expected 3 rows to rewrite, but there are 2 now/)
    await expect(run(db, ['--apply', '--expect', 'two'])).rejects.toThrow(/--expect needs a whole number/)
    await expect(run(db, ['--apply', '--expect'])).rejects.toThrow(/--expect needs a value/)
    await expect(run(db, ['--expect', '--apply'])).rejects.toThrow(/--expect needs a value/)
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
    expect(db.contactPhone.updateMany).not.toHaveBeenCalled()
    expect(preImages()).toEqual([])
  })

  it('unknown or repeated arguments are refused (a typo must not run something else)', async () => {
    const db = fakeDb([opt('a', '9175550147')], [])
    await expect(run(db, ['--restor', 'x.json', '--apply', '--expect', '1'])).rejects.toThrow(/unknown argument "--restor"/)
    await expect(run(db, ['--apply', '--expect', '1', '--expect', '9'])).rejects.toThrow(/--expect given twice/)
    await expect(run(db, ['apply'])).rejects.toThrow(/unknown argument "apply"/)
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
  })

  it('--apply --expect n: saves the private before-image first, then rewrites each row', async () => {
    let savedBeforeFirstWrite: boolean | null = null
    const db = fakeDb([opt('a', '9175550147')], [cp('p1', '718-555-0102')], {
      onUpdate: () => { savedBeforeFirstWrite ??= preImages().length === 1 },
    })
    await run(db, ['--apply', '--expect', '2'])
    expect(savedBeforeFirstWrite).toBe(true)
    const [file] = preImages()
    expect(file).toBe('brief41-canonical-phones-preimage-2026-10-11T12-00-00-000Z.json')
    const full = path.join(dir, 'private', file)
    expect(statSync(full).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(dir, 'private')).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(full, 'utf8'))).toEqual({
      script: 'brief41-canonical-phones', createdAt: '2026-10-11T12:00:00.000Z', database: 'dealflow_crm_test',
      rows: [
        { table: 'DncSuppression', id: 'a', oldPhone: '9175550147', newPhone: '+19175550147' },
        { table: 'ContactPhone', id: 'p1', oldPhone: '718-555-0102', newPhone: '+17185550102' },
      ],
    })
    expect(db.dncSuppression.updateMany).toHaveBeenCalledWith({ where: { id: 'a', phone: '9175550147' }, data: { phone: '+19175550147' } })
    expect(jsonLine('rewritten')).toEqual({ rewritten: 2, changedSinceDryRun: [], conflicts: [] })
    // Nothing printed carries a phone number.
    expect(lines.join('\n')).not.toMatch(/\d{7}/)
    // Done: a new dry run finds nothing left.
    lines = []
    await run(db, [])
    expect(JSON.parse(lines[0]).rowsToRewrite).toBe(0)
  })

  it('a row changed since the dry run is skipped and reported, not overwritten', async () => {
    const dnc = [opt('a', '9175550147'), opt('b', '7185550102')]
    const db = fakeDb(dnc, [], {
      // Someone edits row b while the script runs (after it was read).
      onUpdate: (_t, id) => { if (id === 'a') dnc[1].phone = '+13475550199' },
    })
    await run(db, ['--apply', '--expect', '2'])
    expect(jsonLine('rewritten')).toEqual({ rewritten: 1, changedSinceDryRun: ['DncSuppression:b'], conflicts: [] })
    expect(dnc.map((r) => r.phone)).toEqual(['+19175550147', '+13475550199'])
  })

  it('a canonical row that appeared meanwhile is a reported conflict, not a crash', async () => {
    const dnc = [opt('a', '9175550147')]
    const db = fakeDb(dnc, [], { onUpdate: () => { dnc.push(opt('new', '+19175550147')) } })
    await run(db, ['--apply', '--expect', '1'])
    expect(jsonLine('rewritten')).toEqual({ rewritten: 0, changedSinceDryRun: [], conflicts: ['DncSuppression:a'] })
    expect(dnc[0].phone).toBe('9175550147')
  })

  it('a run that stops partway says how far it got and how to finish or undo; the before-image undoes exactly what was written', async () => {
    const dnc = [opt('a', '9175550147'), opt('b', '7185550102'), opt('c', '2125550101'), opt('d', '6465550100')]
    const db = fakeDb(dnc, [], {
      onUpdate: (_t, _id, n) => { if (n === 3) throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' }) },
    })
    await expect(run(db, ['--apply', '--expect', '4'])).rejects.toThrow(/stopped after 2 of 4 row\(s\): Can't reach database server/)
    expect(lines).toContain('STOPPED PARTWAY: 2 of 4 row(s) handled before the error.')
    expect(jsonLine('written')).toEqual({ written: 2, notHoldingExpected: [], conflicts: [] })
    expect(lines.some((l) => l.startsWith('To finish: run the dry run again'))).toBe(true)
    expect(lines.some((l) => l.startsWith('To undo what was written: --restore '))).toBe(true)
    expect(dnc.map((r) => r.phone)).toEqual(['+19175550147', '+17185550102', '2125550101', '6465550100'])
    // Undo: the restore dry run reads which rows still hold the new value.
    const file = path.join(dir, 'private', preImages()[0])
    const db2 = fakeDb(dnc, [])
    lines = []
    await run(db2, ['--restore', file])
    expect(JSON.parse(lines[0])).toEqual({ restore: file, rowsInFile: 4, rowsToRestore: 2, changedSinceOrNeverRewritten: 2 })
    expect(lines.at(-1)).toContain('--apply --expect 2 (plus --i-mean-live on the live CRM)')
    await run(db2, ['--restore', file, '--apply', '--expect', '2'])
    expect(dnc.map((r) => r.phone)).toEqual(['9175550147', '7185550102', '2125550101', '6465550100'])
  })

  it('stops hard if one conditional write ever matched more than one row', async () => {
    const db = fakeDb([opt('a', '9175550147')], [], { matchAll: true })
    await expect(run(db, ['--apply', '--expect', '1'])).rejects.toThrow(/DncSuppression:a matched 2 rows/)
  })

  it('refuses a before-image folder inside the repo or any git checkout (real paths, any case), and never overwrites one', async () => {
    const db = fakeDb([opt('a', '9175550147')], [])
    const refused = async (where: string) => {
      await expect(run(db, ['--apply', '--expect', '1', '--preimage-dir', where])).rejects.toThrow(/outside any git checkout/)
    }
    await refused(path.join(repo, 'backups'))
    await refused(repo)
    await refused(path.join(repo, '..private')) // a folder whose name starts with ".."
    await refused(path.join(repo.toUpperCase(), 'x')) // another spelling of the same folder
    symlinkSync(repo, path.join(dir, 'link-to-repo'))
    await refused(path.join(dir, 'link-to-repo', 'x')) // a symlink into the repo
    const other = path.join(dir, 'other-checkout')
    mkdirSync(path.join(other, '.git'), { recursive: true })
    await refused(path.join(other, 'private')) // another git checkout
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
    await run(db, ['--apply', '--expect', '1'])
    // Same timestamp again: refuses rather than overwrite the first one.
    const again = fakeDb([opt('b', '2125550101')], [])
    await expect(run(again, ['--apply', '--expect', '1'])).rejects.toThrow(/EEXIST/)
    expect(again.dncSuppression.updateMany).not.toHaveBeenCalled()
  })

  it('--restore puts the old values back (dry run first), skipping rows changed since', async () => {
    const dnc = [opt('a', '9175550147'), opt('b', '7185550102')]
    const phones = [cp('p1', '718-555-0102')]
    const db = fakeDb(dnc, phones)
    await run(db, ['--apply', '--expect', '3'])
    const file = path.join(dir, 'private', preImages()[0])
    phones[0].phone = '+19175550123' // edited after the backfill: the undo must leave it alone
    lines = []
    await run(db, ['--restore', file])
    expect(JSON.parse(lines[0])).toEqual({ restore: file, rowsInFile: 3, rowsToRestore: 2, changedSinceOrNeverRewritten: 1 })
    expect(dnc.map((r) => r.phone)).toEqual(['+19175550147', '+17185550102'])
    await expect(run(db, ['--restore', file, '--apply'])).rejects.toThrow(/--expect/)
    await expect(run(db, ['--restore', file, '--apply', '--expect', '3'])).rejects.toThrow(/expected 3 rows to restore, but there are 2/)
    await run(db, ['--restore', file, '--apply', '--expect', '2'])
    expect(dnc.map((r) => r.phone)).toEqual(['9175550147', '7185550102'])
    expect(phones[0].phone).toBe('+19175550123')
    expect(jsonLine('restored')).toEqual({ restored: 2, notHoldingTheNewValue: [], conflicts: [] })
  })

  it('--restore refuses a before-image from another database', async () => {
    const db = fakeDb([opt('a', '+19175550147')], [])
    const file = writePre([{ table: 'DncSuppression', id: 'a', oldPhone: '9175550147', newPhone: '+19175550147' }], 'dealflow_crm_test')
    await expect(run(db, ['--restore', file], 'dealflow_crm')).rejects.toThrow(/taken from database "dealflow_crm_test", not "dealflow_crm"/)
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
  })

  it('--restore refuses the whole file if any row is malformed, naming the row and never a phone number', () => {
    const good = { table: 'DncSuppression', id: 'a', oldPhone: '9175550147', newPhone: '+19175550147' }
    const bad: Array<[string, unknown]> = [
      ['missing newPhone', [{ ...good, newPhone: undefined }]],
      ['missing id', [{ ...good, id: undefined }]],
      ['table spelled differently', [{ ...good, table: 'dncSuppression' }]],
      ['no change', [{ ...good, newPhone: good.oldPhone }]],
      ['a number as phone', [{ ...good, oldPhone: 9175550147 }]],
      ['repeated row', [good, { ...good }]],
    ]
    for (const [, rows] of bad) {
      const file = writePre(rows)
      let message = ''
      try { readPreImage(file) } catch (err) { message = (err as Error).message }
      expect(message).toMatch(/^REFUSING: .* row \d+ (is malformed|repeats)/)
      expect(message).not.toMatch(/\d{7}/)
    }
    // Not JSON: the parser's message (which quotes the file) isn't passed on.
    const broken = path.join(dir, 'broken.json')
    writeFileSync(broken, '{"rows":[{"newPhone":+19175550147}]}')
    expect(() => readPreImage(broken)).toThrow(/^REFUSING: .* is not valid JSON$/)
  })
})
