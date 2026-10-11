import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { planPhoneBackfill } from '@/lib/compliance/dnc/phoneBackfill'
import { backfillWrites, runPhoneBackfill, type BackfillDb } from '@/lib/compliance/dnc/phoneBackfillRun'

// Brief 41.1 (PR F): the phone backfill on the live CRM keeps a private
// before-image, needs the approved dry-run count, and only writes rows that
// still hold the phone the dry run saw. An in-memory fake of the two tables.
type Row = { id: string; phone: string; organizationId?: string; source?: string; contactId?: string }

function fakeDb(dnc: Row[], phones: Row[], opts: { onUpdate?: (table: string, id: string) => void } = {}) {
  const tables = { DncSuppression: dnc, ContactPhone: phones }
  const updateMany = (table: keyof typeof tables) =>
    vi.fn(async ({ where, data }: { where: { id: string; phone: string }; data: { phone: string } }) => {
      opts.onUpdate?.(table, where.id)
      const row = tables[table].find((r) => r.id === where.id && r.phone === where.phone)
      if (!row) return { count: 0 }
      const clash = tables[table].find((r) =>
        r !== row && r.phone === data.phone &&
        (table === 'DncSuppression' ? r.organizationId === row.organizationId && r.source === row.source : r.contactId === row.contactId))
      if (clash) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      row.phone = data.phone
      return { count: 1 }
    })
  const db = {
    dncSuppression: { findMany: vi.fn(async () => dnc.map((r) => ({ ...r })) as any), updateMany: updateMany('DncSuppression') },
    contactPhone: { findMany: vi.fn(async () => phones.map((r) => ({ ...r })) as any), updateMany: updateMany('ContactPhone') },
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

const run = (db: BackfillDb, args: string[]) =>
  runPhoneBackfill({
    db, args, log: (l) => lines.push(l), database: 'dealflow_crm_test', repoRoot: repo,
    defaultPreImageDir: path.join(dir, 'private'), now: () => new Date('2026-10-11T12:00:00.000Z'),
  })
const preImages = () => (existsSync(path.join(dir, 'private')) ? readdirSync(path.join(dir, 'private')) : [])

describe('phone backfill: before-image, --expect, conditional writes', () => {
  it('the writes carry each row old and new phone, opt-outs first', () => {
    const dnc = [opt('a', '9173312047'), opt('b', '+12125550101')]
    const phones = [cp('p1', '(718) 555-0102')]
    expect(backfillWrites(planPhoneBackfill(dnc as any, phones as any), dnc as any, phones as any)).toEqual([
      { table: 'DncSuppression', id: 'a', oldPhone: '9173312047', newPhone: '+19173312047' },
      { table: 'ContactPhone', id: 'p1', oldPhone: '(718) 555-0102', newPhone: '+17185550102' },
    ])
  })

  it('dry run: counts and the --expect to use; writes nothing, saves nothing', async () => {
    const db = fakeDb([opt('a', '9173312047')], [cp('p1', '718-555-0102'), cp('p2', 'call office')])
    await run(db, [])
    const summary = JSON.parse(lines[0])
    expect(summary).toMatchObject({ optOutsToRewrite: 1, contactPhonesToRewrite: 1, contactPhonesNotAPhoneNumber: ['p2'], rowsToRewrite: 2 })
    expect(lines.at(-1)).toContain('--apply --expect 2')
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
    expect(db.contactPhone.updateMany).not.toHaveBeenCalled()
    expect(preImages()).toEqual([])
  })

  it('--apply without --expect, or with a different count, refuses before writing or saving anything', async () => {
    const db = fakeDb([opt('a', '9173312047')], [cp('p1', '718-555-0102')])
    await expect(run(db, ['--apply'])).rejects.toThrow(/REFUSING: --apply needs --expect <n>.*it is 2 now/)
    await expect(run(db, ['--apply', '--expect', '3'])).rejects.toThrow(/REFUSING: expected 3 rows to rewrite, but there are 2 now/)
    await expect(run(db, ['--apply', '--expect', 'two'])).rejects.toThrow(/--expect needs a whole number/)
    await expect(run(db, ['--apply', '--expect'])).rejects.toThrow(/--expect needs a value/)
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
    expect(db.contactPhone.updateMany).not.toHaveBeenCalled()
    expect(preImages()).toEqual([])
  })

  it('--apply --expect n: saves the private before-image first, then rewrites each row', async () => {
    let savedBeforeFirstWrite: boolean | null = null
    const db = fakeDb([opt('a', '9173312047')], [cp('p1', '718-555-0102')], {
      onUpdate: () => { savedBeforeFirstWrite ??= preImages().length === 1 },
    })
    await run(db, ['--apply', '--expect', '2'])
    expect(savedBeforeFirstWrite).toBe(true)
    const [file] = preImages()
    expect(file).toBe('brief41-canonical-phones-preimage-2026-10-11T12-00-00-000Z.json')
    const full = path.join(dir, 'private', file)
    expect(statSync(full).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(full, 'utf8'))).toEqual({
      script: 'brief41-canonical-phones', createdAt: '2026-10-11T12:00:00.000Z', database: 'dealflow_crm_test',
      rows: [
        { table: 'DncSuppression', id: 'a', oldPhone: '9173312047', newPhone: '+19173312047' },
        { table: 'ContactPhone', id: 'p1', oldPhone: '718-555-0102', newPhone: '+17185550102' },
      ],
    })
    expect(db.dncSuppression.updateMany).toHaveBeenCalledWith({ where: { id: 'a', phone: '9173312047' }, data: { phone: '+19173312047' } })
    expect(JSON.parse(lines.find((l) => l.includes('"rewritten"'))!)).toEqual({ rewritten: 2, changedMeanwhile: [], conflicts: [] })
    // Done: a new dry run finds nothing left.
    lines = []
    await run(db, [])
    expect(JSON.parse(lines[0]).rowsToRewrite).toBe(0)
  })

  it('a row changed since the dry run is skipped and reported, not overwritten', async () => {
    const dnc = [opt('a', '9173312047'), opt('b', '7185550102')]
    const db = fakeDb(dnc, [], {
      // Someone edits row b while the script runs (after it was read).
      onUpdate: (_t, id) => { if (id === 'a') dnc[1].phone = '+13475550000' },
    })
    await run(db, ['--apply', '--expect', '2'])
    expect(JSON.parse(lines.find((l) => l.includes('"rewritten"'))!)).toEqual({ rewritten: 1, changedMeanwhile: ['DncSuppression:b'], conflicts: [] })
    expect(dnc.map((r) => r.phone)).toEqual(['+19173312047', '+13475550000'])
  })

  it('a canonical row that appeared meanwhile is a reported conflict, not a crash', async () => {
    const dnc = [opt('a', '9173312047')]
    const db = fakeDb(dnc, [], { onUpdate: () => { dnc.push(opt('new', '+19173312047')) } })
    await run(db, ['--apply', '--expect', '1'])
    expect(JSON.parse(lines.find((l) => l.includes('"rewritten"'))!)).toEqual({ rewritten: 0, changedMeanwhile: [], conflicts: ['DncSuppression:a'] })
    expect(dnc[0].phone).toBe('9173312047')
  })

  it('refuses a before-image folder inside the repo, and never overwrites a before-image', async () => {
    const db = fakeDb([opt('a', '9173312047')], [])
    await expect(run(db, ['--apply', '--expect', '1', '--preimage-dir', path.join(repo, 'backups')])).rejects.toThrow(/outside the repo/)
    await expect(run(db, ['--apply', '--expect', '1', '--preimage-dir', repo])).rejects.toThrow(/outside the repo/)
    expect(db.dncSuppression.updateMany).not.toHaveBeenCalled()
    await run(db, ['--apply', '--expect', '1'])
    // Same timestamp again: refuses rather than overwrite the first one.
    const again = fakeDb([opt('b', '2125550101')], [])
    await expect(run(again, ['--apply', '--expect', '1'])).rejects.toThrow(/EEXIST/)
    expect(again.dncSuppression.updateMany).not.toHaveBeenCalled()
  })

  it('--restore puts the old values back from the before-image (dry run first), skipping rows changed since', async () => {
    const dnc = [opt('a', '9173312047'), opt('b', '7185550102')]
    const phones = [cp('p1', '718-555-0102')]
    const db = fakeDb(dnc, phones)
    await run(db, ['--apply', '--expect', '3'])
    const file = path.join(dir, 'private', preImages()[0])
    phones[0].phone = '+19175550123' // edited after the backfill: the undo must leave it alone
    lines = []
    await run(db, ['--restore', file])
    expect(JSON.parse(lines[0])).toEqual({ restore: file, rowsToRestore: 3 })
    expect(dnc.map((r) => r.phone)).toEqual(['+19173312047', '+17185550102'])
    await expect(run(db, ['--restore', file, '--apply'])).rejects.toThrow(/--expect/)
    await run(db, ['--restore', file, '--apply', '--expect', '3'])
    expect(dnc.map((r) => r.phone)).toEqual(['9173312047', '7185550102'])
    expect(phones[0].phone).toBe('+19175550123')
    expect(JSON.parse(lines.find((l) => l.includes('"rewritten"'))!)).toEqual({ rewritten: 2, changedMeanwhile: ['ContactPhone:p1'], conflicts: [] })
  })
})
