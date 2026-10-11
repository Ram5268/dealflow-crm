import { describe, it, expect } from 'vitest'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import { claimImportCommit, getImportStatus, mappingKey, type CommitClaim } from '@/lib/core-data/importer/batch'
import {
  BATCH, ORG, PHONE_ONLY, col, emitOk, gate, importWorld, mappingOf, phoneCsv, phoneOf, settle, until,
} from './helpers/fake-import-db'

// Brief 41.1 (F1): an import run only writes its batch while it holds the
// claim. Fake DB (no database); see helpers/fake-import-db.ts.
const runIdOf = (c: CommitClaim) => (c as { runId?: string }).runId
const runOf = (mappingJson: unknown) => (mappingJson as { importRun?: { id: string; beatAt: string } } | null)?.importRun
const inAMinute = { now: () => Date.now() + 61_000 }

describe('watchdog race (reviewer probe probe-watchdog-race, Brief 41.1 F1)', () => {
  it("a stopped run's late 'failed' write can't reopen a newer run's import, so no homeowner is imported twice", async () => {
    const N = 200
    const w = importWorld(phoneCsv(N))
    const claim1 = await claimImportCommit(w.db('claim1'), BATCH, ORG, PHONE_ONLY)
    expect(claim1.claimed).toBe(true)

    // Run 1: the phone lookup of the 4th row hangs; its clock stops it after
    // 29 rows; its watchdog fires at 60 ms. Once its watchdog has marked the
    // import failed, its later writes to the batch are held up in the network.
    const hung = gate()
    const late = gate()
    let clock = 0
    const db1 = w.db('run1', {
      before: (op, arg) => {
        if (op === 'lead.findMany' && (arg as { phone: string }).phone === phoneOf(3)) return hung.hold()
        if (op.startsWith('importBatch.update') && w.landed('run1').some((x) => x.data.status === 'failed')) return late.hold()
      },
    })
    const run1 = settle(
      commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', {
        db: db1, emit: emitOk, runId: runIdOf(claim1), now: () => (++clock > 30 ? 1e9 : 0), timeLimitMs: 1_000, watchdogMs: 60,
      })
    )
    await until(() => w.batch.status === 'failed') // the watchdog

    // Ryan presses "Back to the import" → Commit as soon as the page says failed...
    const early = await claimImportCommit(w.db('claim2'), BATCH, ORG, PHONE_ONLY)
    // ...meanwhile run 1's hung lookup returns, it finishes that row and sends
    // its own late 'failed' write, which is still on its way.
    hung.release()
    await late.arrived
    // A minute later he tries again (on Vercel the old run is gone by then).
    const claim2 = early.claimed ? early : await claimImportCommit(w.db('claim2'), BATCH, ORG, PHONE_ONLY, inAMinute)
    expect(claim2.claimed).toBe(true)
    const run2 = settle(commitImport(BATCH, 'merge', PHONE_ONLY, 'c2', { db: w.db('run2', { latency: 3 }), emit: emitOk, runId: runIdOf(claim2) }))
    await until(() => w.leads.filter((l) => l.by === 'run2').length >= 5)

    // Run 1's late write lands while run 2 is working; then a third run is
    // tried as soon as the page would offer it.
    late.release()
    await run1
    const claim3 = await claimImportCommit(w.db('claim3'), BATCH, ORG, PHONE_ONLY, inAMinute)
    const run3 = claim3.claimed
      ? settle(commitImport(BATCH, 'merge', PHONE_ONLY, 'c3', { db: w.db('run3', { latency: 1 }), emit: emitOk, runId: runIdOf(claim3) }))
      : null
    await Promise.all([run2, run3])

    // Main: 224 leads for 200 phones (run 3 overlapped run 2).
    expect(w.duplicatePhones()).toEqual([])
    expect(w.leads).toHaveLength(N)
    // The re-run waited for the old run, whose late write never landed, so
    // the third run was refused while run 2 worked.
    expect(early).toMatchObject({ claimed: false, status: 'failed' })
    expect(w.writes.filter((x) => x.by === 'run1' && x.data.status === 'failed' && x.landed)).toHaveLength(1) // the watchdog's only
    expect(claim3).toEqual({ claimed: false, status: 'importing' })
    expect(w.batch).toMatchObject({ status: 'completed', totalRows: N, importedRows: N, errorRows: 0 })
  }, 20_000)
})

describe('a re-run waits a minute after a "stopped responding" failure (Brief 41.1)', () => {
  it('refuses the claim until completedAt + 60 s, also after "Back to the import" re-proposed the mapping', async () => {
    const w = importWorld(phoneCsv(3))
    const claim1 = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    const hang = gate()
    void settle(commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', { db: w.db('run1'), emit: async () => { await hang.hold(); return emitOk() }, runId: runIdOf(claim1), watchdogMs: 30 }))
    await until(() => w.batch.status === 'failed')
    const stoppedAt = w.batch.completedAt!.getTime()
    const at = (ms: number) => ({ now: () => stoppedAt + ms })

    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, at(1_000))).toEqual({ claimed: false, status: 'failed', retryInSeconds: 59 })
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, at(59_500))).toEqual({ claimed: false, status: 'failed', retryInSeconds: 1 })
    w.batch.status = 'mapping_review' // what the mapping page's AI call does to a failed import
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, at(30_000))).toEqual({ claimed: false, status: 'mapping_review', retryInSeconds: 30 })
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, at(60_000))).toMatchObject({ claimed: true })
    hang.release()
  })

  it('a time-limit stop (the run had finished every row it started) can be run again at once', async () => {
    const w = importWorld(phoneCsv(6))
    const claim1 = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    let t = 0
    const r = await settle(commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', { db: w.db('run1'), emit: emitOk, runId: runIdOf(claim1), now: () => (t += 1000), timeLimitMs: 2_500 }))
    expect(r.ok).toBe(false)
    expect(w.batch.status).toBe('failed')
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)).toMatchObject({ claimed: true })
  })

  it("the run's own late failure replaces its watchdog failure (more exact), which lifts the wait", async () => {
    // As on Vercel: the time limit stops new rows, one row hangs past it, the
    // watchdog fires, then the hung row returns and the run records its stop.
    const w = importWorld(phoneCsv(3))
    const claim1 = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    const hung = gate()
    let clock = 0
    const run1 = settle(
      commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', {
        db: w.db('run1', { before: (op, arg) => (op === 'lead.findMany' && (arg as { phone: string }).phone === phoneOf(1) ? hung.hold() : undefined) }),
        emit: emitOk, runId: runIdOf(claim1), now: () => (++clock > 3 ? 1e9 : 0), timeLimitMs: 1_000, watchdogMs: 30,
      })
    )
    await until(() => w.batch.status === 'failed')
    expect(JSON.stringify(w.batch.errorLog)).toContain('"watchdog":true')
    expect(w.batch.importedRows).toBe(1)
    hung.release()
    expect(await run1).toMatchObject({ ok: false })
    expect(w.batch.status).toBe('failed')
    expect(JSON.stringify(w.batch.errorLog)).not.toContain('"watchdog":true')
    expect(JSON.stringify(w.batch.errorLog)).toMatch(/stopped responding after 2 of 3 rows/)
    expect(w.batch.importedRows).toBe(2)
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)).toMatchObject({ claimed: true })
  })
})

describe("late writes from an old run never overwrite a newer run (Brief 41.1)", () => {
  it("an old run's late completion is refused while a newer run works", async () => {
    const w = importWorld(phoneCsv(3))
    const claim1 = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    const hang = gate()
    let sent = 0
    const run1 = settle(
      commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', {
        db: w.db('run1'), runId: runIdOf(claim1), watchdogMs: 30,
        emit: async () => { if (++sent === 2) await hang.hold(); return emitOk() }, // row 2's event hangs
      })
    )
    await until(() => w.batch.status === 'failed')
    // A minute later, with another mapping: a fresh run from row 1, held up on its first lookup.
    const OTHER = mappingOf(col('Phone', 'ContactPhone.phone'), col('Name', 'Contact.name'))
    const claim2 = await claimImportCommit(w.db('claim'), BATCH, ORG, OTHER, inAMinute)
    expect(claim2.claimed).toBe(true)
    const hold2 = gate()
    const run2 = settle(commitImport(BATCH, 'merge', OTHER, 'c2', { db: w.db('run2', { before: (op) => (op === 'lead.findMany' ? hold2.hold() : undefined) }), emit: emitOk, runId: runIdOf(claim2) }))
    await hold2.arrived

    hang.release() // run 1 now finishes every row and sends 'completed'
    await run1
    expect(w.writes.filter((x) => x.by === 'run1' && x.data.status === 'completed' && x.landed)).toEqual([])
    expect(w.batch).toMatchObject({ status: 'importing', importedRows: 0 })
    expect(runOf(w.batch.mappingJson)?.id).toBe(runIdOf(claim2))

    hold2.release()
    await run2
    expect(w.batch).toMatchObject({ status: 'completed', totalRows: 3, importedRows: 3, duplicateRows: 3 })
    expect(w.leads).toHaveLength(3)
  })

  it("an old run's late progress write doesn't overwrite a newer run's counts", async () => {
    const w = importWorld(phoneCsv(150))
    const claim1 = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    const late = gate()
    // Run 1's progress write at 100 rows is held up; its watchdog fires meanwhile.
    const isProgress = (arg: unknown) => {
      const data = (arg as { data: Record<string, unknown> }).data
      return data.status === undefined && data.importedRows !== undefined
    }
    const run1 = settle(
      commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', {
        db: w.db('run1', { before: (op, arg) => (op.startsWith('importBatch.update') && isProgress(arg) ? late.hold() : undefined) }),
        emit: emitOk, runId: runIdOf(claim1), watchdogMs: 50,
      })
    )
    await late.arrived
    await until(() => w.batch.status === 'failed')
    const OTHER = mappingOf(col('Phone', 'ContactPhone.phone'), col('Name', 'Contact.name'))
    const claim2 = await claimImportCommit(w.db('claim'), BATCH, ORG, OTHER, inAMinute)
    expect(claim2.claimed).toBe(true)
    const hold2 = gate()
    const run2 = settle(commitImport(BATCH, 'merge', OTHER, 'c2', { db: w.db('run2', { before: (op) => (op === 'lead.findMany' ? hold2.hold() : undefined) }), emit: emitOk, runId: runIdOf(claim2) }))
    await hold2.arrived

    late.release() // run 1's progress write (importedRows ≈ 100) lands now
    await run1
    expect(w.writes.filter((x) => x.by === 'run1' && x.landed && x.data.importedRows !== undefined && x.data.status === undefined)).toEqual([])
    expect(w.batch).toMatchObject({ status: 'importing', importedRows: 0 })

    hold2.release()
    await run2
    expect(w.batch).toMatchObject({ status: 'completed', totalRows: 150, importedRows: 150 })
    expect(w.duplicatePhones()).toEqual([])
  })

  it('a commit whose run no longer holds the import (a retried job, a replaced run) does nothing', async () => {
    const w = importWorld(phoneCsv(3))
    const claim1 = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    await commitImport(BATCH, 'merge', PHONE_ONLY, 'x', { db: w.db('stray'), emit: emitOk, runId: 'a-run-that-lost-the-claim' })
    expect(w.leads).toHaveLength(0)
    expect(w.writes.filter((x) => x.by === 'stray')).toEqual([])
    expect(w.batch).toMatchObject({ status: 'importing', importedRows: 0 })
    const res = await commitImport(BATCH, 'merge', PHONE_ONLY, 'c1', { db: w.db('run1'), emit: emitOk, runId: runIdOf(claim1) })
    expect(res).toMatchObject({ totalRows: 3, importedRows: 3 })
    expect(w.batch.status).toBe('completed')
  })

  it('a direct commit with no run id never runs beside a claimed run', async () => {
    const w = importWorld(phoneCsv(3))
    expect((await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)).claimed).toBe(true)
    await expect(commitImport(BATCH, 'merge', PHONE_ONLY, 'x', { db: w.db('direct'), emit: emitOk })).rejects.toThrow(/claim/)
    expect(w.leads).toHaveLength(0)
    expect(w.batch).toMatchObject({ status: 'importing', importedRows: 0 })
  })
})

describe("an import stuck at 'importing' with no live run can be run again (Brief 41.1)", () => {
  const T0 = Date.parse('2026-10-11T12:00:00Z')
  const minutes = (m: number) => ({ now: () => T0 + m * 60_000 })
  const stuck = () =>
    importWorld(phoneCsv(3), {
      status: 'importing',
      createdAt: new Date(T0 - 3_600_000),
      mappingJson: { ...PHONE_ONLY, importRun: { id: 'dead-run', beatAt: new Date(T0).toISOString() } },
      totalRows: 3,
      importedRows: 2,
      // An earlier stop's resume point; the dead run's counts are already past it.
      errorLog: [{ row: 0, message: 'Import stopped: time limit reached after 1 of 3 rows', resume: { next: 1, partial: [] }, mappingKey: mappingKey(PHONE_ONLY) }],
    })

  it('after 10 minutes with no progress it is claimed again, from row 1, and the dead run can no longer write', async () => {
    const w = stuck()
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, minutes(9))).toEqual({ claimed: false, status: 'importing' })
    const claim = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, minutes(10))
    expect(claim).toMatchObject({ claimed: true })
    expect(w.batch).toMatchObject({ status: 'importing', importedRows: 0, errorLog: [] })
    expect(runOf(w.batch.mappingJson)?.id).toBe(runIdOf(claim))

    await commitImport(BATCH, 'merge', PHONE_ONLY, 'old', { db: w.db('dead'), emit: emitOk, runId: 'dead-run' })
    expect(w.leads).toHaveLength(0)
    const res = await commitImport(BATCH, 'merge', PHONE_ONLY, 'c', { db: w.db('run'), emit: emitOk, runId: runIdOf(claim) })
    expect(res).toMatchObject({ totalRows: 3, importedRows: 3, errorRows: 0 })
    expect(w.batch.status).toBe('completed')
  })

  it('only one of two simultaneous re-runs of a stuck import wins', async () => {
    const w = stuck()
    const claims = await Promise.all([1, 2, 3].map(() => claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, minutes(11))))
    expect(claims.filter((c) => c.claimed)).toHaveLength(1)
  })

  it('the status read flags it, so the page offers to run it again', async () => {
    const w = stuck()
    expect(await getImportStatus(w.db('read'), BATCH, ORG, T0 + 9 * 60_000)).toMatchObject({ status: 'importing', stalled: false })
    const s = await getImportStatus(w.db('read'), BATCH, ORG, T0 + 10 * 60_000)
    expect(s).toMatchObject({ status: 'importing', stalled: true, retryInSeconds: 0 })
    expect(s).not.toHaveProperty('mappingJson')
    expect(s).not.toHaveProperty('sourceBlob')
  })

  it('an import claimed before run ids existed counts from its upload time', async () => {
    const w = importWorld(phoneCsv(2), { status: 'importing', createdAt: new Date(T0), mappingJson: PHONE_ONLY })
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, minutes(5))).toEqual({ claimed: false, status: 'importing' })
    expect(await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY, minutes(10))).toMatchObject({ claimed: true })
  })

  it('a working run keeps a heartbeat, so it never looks stuck', async () => {
    const w = importWorld(phoneCsv(250))
    const claim = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    expect(runIdOf(claim)).toEqual(expect.any(String))
    await commitImport(BATCH, 'merge', PHONE_ONLY, 'c', { db: w.db('run'), emit: emitOk, runId: runIdOf(claim) })
    // The start and the progress writes (every 100 rows) carry the heartbeat.
    const beats = w.landed('run').filter((x) => runOf(x.data.mappingJson)?.id === runIdOf(claim))
    expect(beats.length).toBe(3)
    const counted = beats.slice(1).map((x) => x.data.importedRows as number)
    expect(counted[0]).toBeGreaterThanOrEqual(100)
    expect(counted[1]).toBeGreaterThanOrEqual(200)
  })
})

describe('progress never passes 100% (Brief 41.1)', () => {
  it('a row whose event fails is counted once, as imported, and the failure is listed', async () => {
    const w = importWorld(phoneCsv(10))
    const claim = await claimImportCommit(w.db('claim'), BATCH, ORG, PHONE_ONLY)
    let n = 0
    const flaky = async () => {
      if (++n % 2 === 0) throw new Error('NOTIFY failed')
      return emitOk()
    }
    const res = await commitImport(BATCH, 'merge', PHONE_ONLY, 'c', { db: w.db('run'), emit: flaky, runId: runIdOf(claim) })
    expect(res).toMatchObject({ totalRows: 10, importedRows: 10, skippedRows: 0, errorRows: 0 })
    expect((await getImportStatus(w.db('read'), BATCH, ORG))?.progress).toBe(100)
    expect(JSON.stringify(w.batch.errorLog)).toMatch(/imported, but its sync event failed: NOTIFY failed/)
  })

  it('the status read caps progress at 100%', async () => {
    const w = importWorld(phoneCsv(1), { status: 'importing', totalRows: 10, importedRows: 9, errorRows: 3 })
    expect((await getImportStatus(w.db('read'), BATCH, ORG))?.progress).toBe(100)
  })
})
