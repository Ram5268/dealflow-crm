import { describe, it, expect, vi, beforeEach } from 'vitest'

const db: any = vi.hoisted(() => {
  const d: any = {
    sequence: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    contact: { findFirst: vi.fn() },
    sequenceEnrollment: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    sequenceStep: { findMany: vi.fn(), update: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
  }
  // updateSequence wraps its writes in a transaction; run the callback against
  // the same mock so assertions still read off `db.*`.
  d.$transaction = vi.fn(async (fn: any) => fn(d))
  return d
})
vi.mock('../../prisma', () => ({ prisma: db }))

import {
  createSequence,
  enrollContact,
  updateEnrollment,
  DuplicateEnrollmentError,
  listSequences,
  getSequence,
  listSteps,
  updateSequence,
  deleteSequence,
  SequenceStepInUseError,
} from './crud'

beforeEach(() => vi.clearAllMocks())

describe('createSequence', () => {
  it('nests step creation + blackoutDates', async () => {
    db.sequence.create.mockImplementation(async (a: any) => ({ id: 's', steps: [], ...a.data }))
    await createSequence('o', {
      name: 'seq',
      channel: 'email',
      blackoutDates: ['2026-08-08'],
      steps: [{ ordinal: 1, delayHours: 0, channel: 'email', templateId: 't' }],
    })
    const arg = db.sequence.create.mock.calls[0][0] as any
    expect(arg.data.steps.create[0].templateId).toBe('t')
    expect(arg.data.blackoutDates).toEqual(['2026-08-08'])
  })

  it('rejects an invalid channel', async () => {
    await expect(createSequence('o', { name: 'x', channel: 'fax' })).rejects.toThrow()
  })
})

describe('enrollContact', () => {
  it('creates an enrollment starting at the first step', async () => {
    db.sequence.findFirst.mockResolvedValue({ id: 's', steps: [{ id: 'st1' }, { id: 'st2' }] })
    db.contact.findFirst.mockResolvedValue({ id: 'c' })
    db.sequenceEnrollment.findFirst.mockResolvedValue(null)
    db.sequenceEnrollment.create.mockImplementation(async (a: any) => ({ id: 'e', ...a.data }))
    await enrollContact('o', { sequenceId: 's', contactId: 'c' })
    expect((db.sequenceEnrollment.create.mock.calls[0][0] as any).data.currentStepId).toBe('st1')
  })

  it('blocks a duplicate active enrollment', async () => {
    db.sequence.findFirst.mockResolvedValue({ id: 's', steps: [] })
    db.contact.findFirst.mockResolvedValue({ id: 'c' })
    db.sequenceEnrollment.findFirst.mockResolvedValue({ id: 'existing' })
    await expect(enrollContact('o', { sequenceId: 's', contactId: 'c' })).rejects.toBeInstanceOf(
      DuplicateEnrollmentError,
    )
  })

  it('errors when the sequence is missing', async () => {
    db.sequence.findFirst.mockResolvedValue(null)
    await expect(enrollContact('o', { sequenceId: 's', contactId: 'c' })).rejects.toThrow(/sequence not found/)
  })
})

describe('updateEnrollment', () => {
  it('validates + applies a status transition', async () => {
    db.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 })
    await updateEnrollment('o', 'e', { status: 'paused' })
    expect(db.sequenceEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'e', organizationId: 'o' },
      data: { status: 'paused' },
    })
  })

  it('rejects an invalid status', async () => {
    await expect(updateEnrollment('o', 'e', { status: 'bogus' })).rejects.toThrow()
  })
})

describe('read + update + delete', () => {
  it('listSequences / getSequence scope by org and order steps', async () => {
    db.sequence.findMany.mockResolvedValue([])
    await listSequences('o')
    expect(db.sequence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'o' } }),
    )
    db.sequence.findFirst.mockResolvedValue({ id: 's', steps: [] })
    expect(await getSequence('o', 's')).toEqual({ id: 's', steps: [] })
  })

  it('listSteps returns the sequence steps, or [] when missing', async () => {
    db.sequence.findFirst.mockResolvedValueOnce({ id: 's', steps: [{ id: 'st1' }] })
    expect(await listSteps('o', 's')).toEqual([{ id: 'st1' }])
    db.sequence.findFirst.mockResolvedValueOnce(null)
    expect(await listSteps('o', 'nope')).toEqual([])
  })

  it('updateSequence applies only the provided fields', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    await updateSequence('o', 's', { name: 'renamed', blackoutDates: ['2026-12-25'] })
    const arg = db.sequence.updateMany.mock.calls[0][0] as any
    expect(arg.data).toEqual({ name: 'renamed', blackoutDates: ['2026-12-25'] })
    expect(arg.data).not.toHaveProperty('channel')
  })

  it('updateSequence with description=null clears it (undefined-vs-null distinction)', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    await updateSequence('o', 's', { description: null })
    expect((db.sequence.updateMany.mock.calls[0][0] as any).data).toEqual({ description: null })
  })

  it('updateSequence PERSISTS steps when the payload includes them (GAP 1 regression)', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    db.sequenceStep.findMany.mockResolvedValue([])
    await updateSequence('o', 's', {
      steps: [
        { ordinal: 1, delayHours: 0, channel: 'email', templateId: 't1' },
        { ordinal: 2, delayHours: 48, channel: 'email', templateId: 't2' },
      ],
    })
    const arg = db.sequenceStep.createMany.mock.calls[0][0] as any
    expect(arg.data).toEqual([
      { sequenceId: 's', ordinal: 1, delayHours: 0, channel: 'email', templateId: 't1' },
      { sequenceId: 's', ordinal: 2, delayHours: 48, channel: 'email', templateId: 't2' },
    ])
  })

  it('updateSequence UPDATES overlapping steps in place, preserving ids', async () => {
    // Fresh ids would strand active enrollments — tick.ts throws when it cannot
    // resolve currentStepId against the step list.
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    db.sequenceStep.findMany.mockResolvedValue([{ id: 'st1' }, { id: 'st2' }])
    await updateSequence('o', 's', {
      steps: [
        { ordinal: 1, delayHours: 6, channel: 'email', templateId: 't1' },
        { ordinal: 2, delayHours: 12, channel: 'sms', templateId: 't9' },
      ],
    })
    expect(db.sequenceStep.update).toHaveBeenCalledTimes(2)
    expect(db.sequenceStep.update.mock.calls[0][0].where).toEqual({ id: 'st1' })
    expect(db.sequenceStep.update.mock.calls[1][0].where).toEqual({ id: 'st2' })
    expect(db.sequenceStep.update.mock.calls[1][0].data.templateId).toBe('t9')
    expect(db.sequenceStep.createMany).not.toHaveBeenCalled()
    expect(db.sequenceStep.deleteMany).not.toHaveBeenCalled()
  })

  it('updateSequence deletes the trailing tail when the list shrinks', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    db.sequenceStep.findMany.mockResolvedValue([{ id: 'st1' }, { id: 'st2' }, { id: 'st3' }])
    db.sequenceEnrollment.findMany.mockResolvedValue([])
    await updateSequence('o', 's', {
      steps: [{ ordinal: 1, delayHours: 0, channel: 'email', templateId: 't1' }],
    })
    expect(db.sequenceStep.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['st2', 'st3'] } },
    })
  })

  it('updateSequence REFUSES to strand an active enrollment sitting on a dropped step', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    db.sequenceStep.findMany.mockResolvedValue([{ id: 'st1' }, { id: 'st2' }])
    db.sequenceEnrollment.findMany.mockResolvedValue([{ currentStepId: 'st2' }])
    await expect(
      updateSequence('o', 's', {
        steps: [{ ordinal: 1, delayHours: 0, channel: 'email', templateId: 't1' }],
      }),
    ).rejects.toBeInstanceOf(SequenceStepInUseError)
    expect(db.sequenceStep.deleteMany).not.toHaveBeenCalled()
  })

  it('updateSequence leaves steps untouched when the payload omits them', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 1 })
    await updateSequence('o', 's', { name: 'renamed' })
    expect(db.sequenceStep.findMany).not.toHaveBeenCalled()
    expect(db.sequenceStep.createMany).not.toHaveBeenCalled()
    expect(db.sequenceStep.deleteMany).not.toHaveBeenCalled()
  })

  it('updateSequence skips step reconciliation when the org does not own it', async () => {
    db.sequence.updateMany.mockResolvedValue({ count: 0 })
    await updateSequence('other-org', 's', {
      steps: [{ ordinal: 1, delayHours: 0, channel: 'email', templateId: 't1' }],
    })
    expect(db.sequenceStep.findMany).not.toHaveBeenCalled()
  })

  it('deleteSequence scopes by org', async () => {
    db.sequence.deleteMany.mockResolvedValue({ count: 1 })
    await deleteSequence('o', 's')
    expect(db.sequence.deleteMany).toHaveBeenCalledWith({ where: { id: 's', organizationId: 'o' } })
  })
})
