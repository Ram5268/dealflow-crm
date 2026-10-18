import { describe, it, expect, afterEach } from 'vitest'
import { graphEnabled, GraphDisabledError, GRAPH_DISABLED, graphDisabledResponse } from './graph-switch'

// Brief 41.2 (PR D): the CRM's Outlook switch. Ryan's instruction: Outlook
// stays on hard pause; switch name confirmed by Ryan 2026-10-17. On only for
// the exact string 'true' (an engineering precaution, like the other switches).
const saved = process.env.GRAPH_ENABLED
afterEach(() => {
  if (saved === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = saved
})

describe('graphEnabled', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['TRUE', 'TRUE'],
    ['1', '1'],
    ['false', 'false'],
    ['yes', 'yes'],
    ['padded', ' true'],
  ])('%s means off', (_name, value) => {
    expect(graphEnabled({ GRAPH_ENABLED: value })).toBe(false)
  })

  it('exactly "true" means on', () => {
    expect(graphEnabled({ GRAPH_ENABLED: 'true' })).toBe(true)
  })

  it('reads process.env by default', () => {
    delete process.env.GRAPH_ENABLED
    expect(graphEnabled()).toBe(false)
    process.env.GRAPH_ENABLED = 'true'
    expect(graphEnabled()).toBe(true)
  })
})

describe('the refusal', () => {
  it('says plainly that Outlook is paused', () => {
    const err = new GraphDisabledError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('GraphDisabledError')
    expect(err.code).toBe('outlook_paused')
    expect(err.message).toMatch(/^Outlook is paused/)
  })

  it('the route answer is a 403 carrying the same message', async () => {
    const res = graphDisabledResponse()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(GRAPH_DISABLED)
    expect(GRAPH_DISABLED).toEqual({ error: 'outlook_paused', message: new GraphDisabledError().message })
  })
})
