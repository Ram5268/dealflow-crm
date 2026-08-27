import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  sequenceEnrollment: { findMany: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn() },
  messageTemplate: { findUnique: vi.fn() },
  message: { create: vi.fn() },
}))
const renderMock = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../templates/render', () => renderMock)

import { runSequenceTick } from './tick'

const ET_FRI_3PM = new Date('2026-08-07T19:00:00Z') // Fri 3pm ET (EDT −4)
const HOUR = 3_600_000

beforeEach(() => {
  vi.clearAllMocks()
  db.contact.findUnique.mockResolvedValue({ id: 'c1', leadId: 'l1', timezone: 'America/New_York' })
  db.messageTemplate.findUnique.mockResolvedValue({
    id: 'tpl',
    bodyText: 'hi {{contact.firstName}}',
    bodyHtml: null,
    subject: 'S',
  })
  db.message.create.mockResolvedValue({ id: 'msg1' })
  db.sequenceEnrollment.update.mockResolvedValue({})
  renderMock.render.mockResolvedValue('rendered')
})

function enrollment(over: Record<string, unknown> = {}) {
  return {
    id: 'enr1',
    organizationId: 'o',
    sequenceId: 'seq1',
    contactId: 'c1',
    status: 'active',
    currentStepId: 's1',
    enrolledAt: ET_FRI_3PM,
    sequence: {
      blackoutDates: [],
      steps: [
        { id: 's1', ordinal: 1, delayHours: 0, channel: 'email', templateId: 'tpl' },
        { id: 's2', ordinal: 2, delayHours: 48, channel: 'email', templateId: 'tpl' },
      ],
    },
    ...over,
  }
}

describe('runSequenceTick', () => {
  it('fires step 1 (delay 0h) and advances currentStepId to step 2', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment()])
    const enqueue = vi.fn(async () => {})
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + HOUR), enqueueSend: enqueue })

    expect(r.sent).toBe(1)
    const data = (db.message.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({
      status: 'outbox',
      direction: 'outgoing',
      channel: 'email',
      templateId: 'tpl',
      sequenceEnrollmentId: 'enr1',
      sequenceId: 'seq1',
    })
    expect(enqueue).toHaveBeenCalledWith('msg1')
    expect(db.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'enr1' }, data: { currentStepId: 's2' } }),
    )
  })

  it('fires step 2 ~48h later and finishes the enrollment', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment({ currentStepId: 's2' })])
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + 49 * HOUR), enqueueSend: vi.fn() })
    expect(r.sent).toBe(1)
    expect(db.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'finished' }) }),
    )
  })

  it('does not fire a step that is not due yet', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment({ currentStepId: 's2' })])
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + 2 * HOUR), enqueueSend: vi.fn() })
    expect(r.sent).toBe(0)
    expect(db.message.create).not.toHaveBeenCalled()
  })

  it('defers a blackout-day step until the next allowed day (Sat→Sun ET)', async () => {
    const enr = enrollment({
      currentStepId: 's1',
      sequence: {
        blackoutDates: ['2026-08-08'], // Saturday
        steps: [{ id: 's1', ordinal: 1, delayHours: 24, channel: 'email', templateId: 'tpl' }],
      },
    })
    db.sequenceEnrollment.findMany.mockResolvedValue([enr])
    // Sat 3pm ET (the deferred-from day) — still not due
    expect((await runSequenceTick({ now: new Date('2026-08-08T19:00:00Z'), enqueueSend: vi.fn() })).sent).toBe(0)
    // Sun 3pm ET — now due
    expect((await runSequenceTick({ now: new Date('2026-08-09T19:00:00Z'), enqueueSend: vi.fn() })).sent).toBe(1)
  })

  it('falls back to America/New_York when contact.timezone is null', async () => {
    db.contact.findUnique.mockResolvedValue({ id: 'c1', leadId: 'l1', timezone: null })
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment()])
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + HOUR), enqueueSend: vi.fn() })
    expect(r.sent).toBe(1)
  })

  it('marks the enrollment error when the step template is missing', async () => {
    db.messageTemplate.findUnique.mockResolvedValue(null)
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment()])
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + HOUR), enqueueSend: vi.fn() })
    expect(r.errored).toBe(1)
    expect(db.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'error' } }),
    )
    expect(db.message.create).not.toHaveBeenCalled()
  })

  it('finishes an enrollment that has no steps', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([
      enrollment({ sequence: { blackoutDates: [], steps: [] } }),
    ])
    const r = await runSequenceTick({ enqueueSend: vi.fn() })
    expect(r.finished).toBe(1)
    expect(db.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'finished' }) }),
    )
  })

  it('only processes active enrollments', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([])
    await runSequenceTick({ enqueueSend: vi.fn() })
    expect(db.sequenceEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'active' } }),
    )
  })

  it('finishes an active enrollment whose currentStepId is null', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment({ currentStepId: null })])
    const r = await runSequenceTick({ enqueueSend: vi.fn() })
    expect(r.finished).toBe(1)
  })

  it('errors an enrollment whose currentStepId is not in the sequence', async () => {
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment({ currentStepId: 'ghost' })])
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + HOUR), enqueueSend: vi.fn() })
    expect(r.errored).toBe(1)
    expect(db.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'error' } }),
    )
  })

  it('renders an html body, tolerates null subject + unresolved contact', async () => {
    db.contact.findUnique.mockResolvedValue(null)
    db.messageTemplate.findUnique.mockResolvedValue({
      id: 'tpl',
      bodyText: 't',
      bodyHtml: '<p>h</p>',
      subject: null,
    })
    db.sequenceEnrollment.findMany.mockResolvedValue([enrollment()])
    const r = await runSequenceTick({ now: new Date(ET_FRI_3PM.getTime() + HOUR), enqueueSend: vi.fn() })
    expect(r.sent).toBe(1)
    const data = (db.message.create.mock.calls[0][0] as any).data
    expect(data.contactId).toBeNull()
    expect(data.subject).toBeNull()
  })
})
