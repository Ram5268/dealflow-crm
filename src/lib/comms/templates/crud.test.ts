import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  messageTemplate: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  sequenceStep: { count: vi.fn() },
}))
vi.mock('../../prisma', () => ({ prisma: db }))

import { createTemplate, updateTemplate, deleteTemplate, TemplateInUseError, listTemplates, getTemplate } from './crud'

beforeEach(() => vi.clearAllMocks())

describe('createTemplate', () => {
  it('validates + auto-extracts mergeFields from subject/body', async () => {
    db.messageTemplate.create.mockImplementation(async (a: any) => ({ id: 't', ...a.data }))
    await createTemplate('o', {
      name: 'x',
      channel: 'email',
      subject: 'Hi {{contact.firstName}}',
      bodyText: 'Hello {{contact.firstName}} — {{lead.custom.est_value}}',
    })
    const data = (db.messageTemplate.create.mock.calls[0][0] as any).data
    expect(data.organizationId).toBe('o')
    expect(data.mergeFields.sort()).toEqual(['contact.firstName', 'lead.custom.est_value'].sort())
  })

  it('rejects invalid input', async () => {
    await expect(createTemplate('o', { channel: 'email' })).rejects.toThrow()
  })
})

describe('updateTemplate', () => {
  it('recomputes mergeFields from the merged body', async () => {
    db.messageTemplate.findFirst.mockResolvedValue({ id: 't', bodyText: 'old', bodyHtml: null, subject: null })
    db.messageTemplate.update.mockImplementation(async (a: any) => ({ id: 't', ...a.data }))
    await updateTemplate('o', 't', { bodyText: 'Hi {{contact.displayName}}' })
    expect((db.messageTemplate.update.mock.calls[0][0] as any).data.mergeFields).toContain('contact.displayName')
  })

  it('returns null when the template is missing', async () => {
    db.messageTemplate.findFirst.mockResolvedValue(null)
    expect(await updateTemplate('o', 'nope', { name: 'x' })).toBeNull()
  })

  it('applies name + channel + subject changes', async () => {
    db.messageTemplate.findFirst.mockResolvedValue({ id: 't', bodyText: 'b', bodyHtml: null, subject: 'old' })
    db.messageTemplate.update.mockImplementation(async (a: any) => ({ id: 't', ...a.data }))
    await updateTemplate('o', 't', { name: 'New', channel: 'sms', subject: 'New {{contact.firstName}}' })
    const data = (db.messageTemplate.update.mock.calls[0][0] as any).data
    expect(data.name).toBe('New')
    expect(data.channel).toBe('sms')
    expect(data.subject).toBe('New {{contact.firstName}}')
    expect(data.mergeFields).toContain('contact.firstName')
  })
})

describe('listTemplates / getTemplate', () => {
  it('filters by channel when provided', async () => {
    db.messageTemplate.findMany.mockResolvedValue([])
    await listTemplates('o', 'email')
    expect(db.messageTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'o', channel: 'email' } }),
    )
  })
  it('lists all channels when unfiltered', async () => {
    db.messageTemplate.findMany.mockResolvedValue([])
    await listTemplates('o')
    expect(db.messageTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'o' } }),
    )
  })
  it('getTemplate scopes by org', async () => {
    db.messageTemplate.findFirst.mockResolvedValue({ id: 't' })
    expect(await getTemplate('o', 't')).toEqual({ id: 't' })
  })
})

describe('deleteTemplate', () => {
  it('blocks deletion when a sequence step references it', async () => {
    db.sequenceStep.count.mockResolvedValue(1)
    await expect(deleteTemplate('o', 't')).rejects.toBeInstanceOf(TemplateInUseError)
    expect(db.messageTemplate.deleteMany).not.toHaveBeenCalled()
  })

  it('deletes when unused', async () => {
    db.sequenceStep.count.mockResolvedValue(0)
    db.messageTemplate.deleteMany.mockResolvedValue({ count: 1 })
    await deleteTemplate('o', 't')
    expect(db.messageTemplate.deleteMany).toHaveBeenCalledWith({ where: { id: 't', organizationId: 'o' } })
  })
})
