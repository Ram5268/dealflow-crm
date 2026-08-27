import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { scrub, isCallable, addInternalDnc } from './compliance'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('scrub', () => {
  it('returns the compliance results on success', async () => {
    fetchMock.mockResolvedValue(
      ok({ results: [{ phone: '+15551234567', callable: true, reasons: [] }] }),
    )
    const r = await scrub(['+15551234567'])
    expect(r).toEqual([{ phone: '+15551234567', callable: true, reasons: [] }])
  })

  it('fails closed on non-2xx (compliance_unavailable, not callable)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const r = await scrub(['+15551234567'])
    expect(r).toEqual([{ phone: '+15551234567', callable: false, reasons: ['compliance_unavailable'] }])
  })

  it('fails closed on network throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await scrub(['+1a', '+1b'])
    expect(r.every((x) => x.callable === false && x.reasons.includes('compliance_unavailable'))).toBe(true)
  })

  it('short-circuits empty input (no fetch)', async () => {
    expect(await scrub([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('isCallable', () => {
  it('resolves a single phone', async () => {
    fetchMock.mockResolvedValue(
      ok({ results: [{ phone: '+1', callable: false, reasons: ['internal_dnc'] }] }),
    )
    expect(await isCallable('+1')).toEqual({ phone: '+1', callable: false, reasons: ['internal_dnc'] })
  })
})

describe('addInternalDnc', () => {
  it('normalizes the merged response shape', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'dnc_1', phone: '+1', source: 'internal', addedAt: '2026-08-27T00:00:00Z', added: true }),
    })
    const r = await addInternalDnc({ phone: '+1', reason: 'sms_stop_received', addedBy: 'sms-inbound-handler' })
    expect(r).toEqual({ id: 'dnc_1', phone: '+1', source: 'internal', addedAt: '2026-08-27T00:00:00Z', added: true })
  })

  it('tolerates a legacy subset (defaults added=true, maps dncId→id)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ dncId: 'x', phone: '+1', source: 'internal', addedAt: '2026-08-27T00:00:00Z' }),
    })
    const r = await addInternalDnc({ phone: '+1' })
    expect(r.id).toBe('x')
    expect(r.added).toBe(true)
  })

  it('throws on non-2xx so the caller can retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) })
    await expect(addInternalDnc({ phone: '+1' })).rejects.toThrow(/HTTP 502/)
  })

  it('fills every default when C returns an empty 201 body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({}) })
    const r = await addInternalDnc({ phone: '+15551239999' })
    expect(r.id).toBe('')
    expect(r.phone).toBe('+15551239999')
    expect(r.source).toBe('internal')
    expect(typeof r.addedAt).toBe('string')
    expect(r.added).toBe(true)
  })
})

describe('scrub — malformed body', () => {
  it('fails closed when results is not an array', async () => {
    fetchMock.mockResolvedValue(ok({ results: 'nope' }))
    const r = await scrub(['+15551112222'])
    expect(r[0].callable).toBe(false)
    expect(r[0].reasons).toEqual(['compliance_unavailable'])
  })
})
