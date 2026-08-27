import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  sequence: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  contact: { findFirst: vi.fn() },
  sequenceEnrollment: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}))
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

  it('deleteSequence scopes by org', async () => {
    db.sequence.deleteMany.mockResolvedValue({ count: 1 })
    await deleteSequence('o', 's')
    expect(db.sequence.deleteMany).toHaveBeenCalledWith({ where: { id: 's', organizationId: 'o' } })
  })
})
