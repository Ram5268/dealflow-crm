import { describe, it, expect, vi, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'

// Mock the shell Prisma singleton with hoisted vi.fn handles (relative specifier
// matches store.ts's import; avoids the `@/` alias, which is broken for repo
// paths containing spaces).
const db = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}))
vi.mock('../../prisma', () => ({ prisma: { oAuthCredential: db } }))

import { encryptToken, decryptToken } from './crypto'
import {
  upsertCredential,
  getCredential,
  getDecryptedRefreshToken,
  markReauthRequired,
  markRevoked,
} from './store'

beforeAll(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('upsertCredential', () => {
  it('encrypts both tokens at rest and keys on [org, provider]', async () => {
    db.upsert.mockResolvedValue({ id: 'x' })
    await upsertCredential({
      orgId: 'o',
      provider: 'gmail',
      emailAddress: 'ryan@elliman.com',
      accessToken: 'AT-plain',
      refreshToken: 'RT-plain',
    })
    const arg = db.upsert.mock.calls[0][0] as any
    expect(arg.where).toEqual({
      organizationId_provider: { organizationId: 'o', provider: 'gmail' },
    })
    expect(arg.create.refreshTokenEncrypted).not.toContain('RT-plain')
    expect(decryptToken(arg.create.refreshTokenEncrypted)).toBe('RT-plain')
    expect(decryptToken(arg.create.accessTokenEncrypted)).toBe('AT-plain')
    expect(arg.create.status).toBe('active')
    expect(arg.create.emailAddress).toBe('ryan@elliman.com')
  })

  it('omits refreshTokenEncrypted from UPDATE when no new refresh token is returned', async () => {
    db.upsert.mockResolvedValue({})
    await upsertCredential({
      orgId: 'o',
      provider: 'gmail',
      emailAddress: 'ryan@elliman.com',
      accessToken: 'AT2',
    })
    const arg = db.upsert.mock.calls.at(-1)![0] as any
    expect(arg.update).not.toHaveProperty('refreshTokenEncrypted')
    expect(arg.create.refreshTokenEncrypted).toBeNull()
  })
})

describe('getCredential', () => {
  it('looks up by the compound unique', async () => {
    db.findUnique.mockResolvedValue(null)
    await getCredential('o', 'gmail')
    expect(db.findUnique).toHaveBeenCalledWith({
      where: { organizationId_provider: { organizationId: 'o', provider: 'gmail' } },
    })
  })
})

describe('getDecryptedRefreshToken', () => {
  it('round-trips and is null-safe', () => {
    const enc = encryptToken('RTx')
    expect(getDecryptedRefreshToken({ refreshTokenEncrypted: enc })).toBe('RTx')
    expect(getDecryptedRefreshToken({ refreshTokenEncrypted: null })).toBeNull()
  })
})

describe('markReauthRequired', () => {
  it('sets status=reauth_required', async () => {
    db.update.mockResolvedValue({})
    await markReauthRequired('id1')
    expect(db.update).toHaveBeenCalledWith({
      where: { id: 'id1' },
      data: { status: 'reauth_required' },
    })
  })
})

describe('markRevoked', () => {
  it('empties both tokens and flags the credential revoked', async () => {
    db.update.mockResolvedValue({ id: 'x' })
    await markRevoked('x')
    expect(db.update).toHaveBeenCalledWith({
      where: { id: 'x' },
      data: {
        accessTokenEncrypted: '',
        refreshTokenEncrypted: null,
        expiresAt: null,
        status: 'revoked',
      },
    })
  })

  it('leaves no decryptable material behind', async () => {
    db.update.mockResolvedValue({ id: 'x' })
    await markRevoked('x')
    const { data } = db.update.mock.calls.at(-1)![0] as any
    expect(() => decryptToken(data.accessTokenEncrypted)).toThrow()
    expect(data.refreshTokenEncrypted).toBeNull()
  })
})
