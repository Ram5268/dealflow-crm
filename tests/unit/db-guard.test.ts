import { describe, it, expect } from 'vitest'
import { assertTestDatabase, databaseName, isTestDatabase, LIVE_OVERRIDE_FLAG } from '@/lib/shared/db-guard'

// Brief 41 (H11): the shared live-database guard for tests and scripts.
const LIVE = 'postgresql://u:p@db.example.com:5432/dealflow_crm?sslmode=require'
const PERF = 'postgresql://u:p@db.example.com:5432/dealflow_crm_perf?sslmode=require'
const TEST = 'postgres://u:p@localhost/crm_test'

describe('live-database guard', () => {
  it('reads the database name from a URL', () => {
    expect(databaseName(LIVE)).toBe('dealflow_crm')
    expect(databaseName(PERF + '&schema=b41_x')).toBe('dealflow_crm_perf')
    expect(databaseName('')).toBeNull()
    expect(databaseName(undefined)).toBeNull()
    expect(databaseName('not a url')).toBeNull()
  })

  it('only *_perf and *_test databases count as test databases', () => {
    expect(isTestDatabase(PERF)).toBe(true)
    expect(isTestDatabase(TEST)).toBe(true)
    expect(isTestDatabase(LIVE)).toBe(false)
    expect(isTestDatabase('postgresql://u:p@h/dealflow_perf_backup')).toBe(false)
    expect(isTestDatabase('postgresql://u:p@h/_perf')).toBe(true)
    expect(isTestDatabase(undefined)).toBe(false)
  })

  it('refuses a non-test database, and says which', () => {
    expect(() => assertTestDatabase(LIVE, 'gate1-smoke', { argv: [] })).toThrow(/REFUSING: gate1-smoke would use database "dealflow_crm"/)
    expect(() => assertTestDatabase(undefined, 'restore', { argv: [] })).toThrow(/"\(not set\)"/)
    expect(() => assertTestDatabase(PERF, 'x', { argv: [] })).not.toThrow()
    expect(() => assertTestDatabase(TEST, 'x', { argv: [] })).not.toThrow()
  })

  it('a script can override with --i-mean-live; the test suite cannot', () => {
    expect(() => assertTestDatabase(LIVE, 'restore', { argv: ['node', 'restore.ts', 'b.json', LIVE_OVERRIDE_FLAG] })).not.toThrow()
    expect(() => assertTestDatabase(LIVE, 'the test suite', { argv: ['vitest', LIVE_OVERRIDE_FLAG], allowOverride: false })).toThrow(/REFUSING/)
  })
})
