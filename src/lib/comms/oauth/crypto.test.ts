import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encryptToken,
  decryptToken,
  loadEncryptionKey,
  generateEncryptionKey,
} from './crypto'

const key = () => Buffer.from(generateEncryptionKey(), 'base64')

describe('encryptToken / decryptToken', () => {
  it('round-trips a refresh token', () => {
    const k = key()
    const secret = '1//0gRefreshTokenValue_ExampleABCDEF-1234567890'
    expect(decryptToken(encryptToken(secret, k), k)).toBe(secret)
  })

  it('round-trips unicode + empty string', () => {
    const k = key()
    expect(decryptToken(encryptToken('', k), k)).toBe('')
    expect(decryptToken(encryptToken('café ☕ 🔐', k), k)).toBe('café ☕ 🔐')
  })

  it('produces a distinct IV each call (ciphertexts differ, both decrypt)', () => {
    const k = key()
    const a = encryptToken('same-plaintext', k)
    const b = encryptToken('same-plaintext', k)
    expect(a).not.toBe(b)
    expect(decryptToken(a, k)).toBe('same-plaintext')
    expect(decryptToken(b, k)).toBe('same-plaintext')
  })

  it('emits the packed iv.tag.ct base64 envelope', () => {
    const packed = encryptToken('x', key())
    const parts = packed.split('.')
    expect(parts).toHaveLength(3)
    // 12-byte IV → 16 base64 chars; 16-byte tag → 24 base64 chars.
    expect(Buffer.from(parts[0], 'base64')).toHaveLength(12)
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(16)
  })

  it('wrong key fails decryption (auth tag mismatch)', () => {
    const packed = encryptToken('secret', key())
    expect(() => decryptToken(packed, key())).toThrow()
  })

  it('tampered ciphertext is rejected by the auth tag', () => {
    const k = key()
    const [iv, tag, ct] = encryptToken('secret', k).split('.')
    const bytes = Buffer.from(ct, 'base64')
    bytes[0] ^= 0xff
    const tampered = [iv, tag, bytes.toString('base64')].join('.')
    expect(() => decryptToken(tampered, k)).toThrow()
  })

  it('tampered auth tag is rejected', () => {
    const k = key()
    const [iv, tag, ct] = encryptToken('secret', k).split('.')
    const bytes = Buffer.from(tag, 'base64')
    bytes[0] ^= 0xff
    const tampered = [iv, bytes.toString('base64'), ct].join('.')
    expect(() => decryptToken(tampered, k)).toThrow()
  })

  it('malformed envelope (not 3 segments) throws a clear error', () => {
    expect(() => decryptToken('not-an-envelope', key())).toThrow(/malformed/)
  })
})

describe('loadEncryptionKey', () => {
  it('accepts a valid base64 32-byte key', () => {
    const raw = randomBytes(32).toString('base64')
    expect(loadEncryptionKey(raw)).toHaveLength(32)
  })

  it('throws when the key is missing', () => {
    expect(() => loadEncryptionKey(undefined)).toThrow(/not set/)
  })

  it('throws when the key is the wrong length', () => {
    expect(() => loadEncryptionKey(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes/,
    )
  })
})

describe('generateEncryptionKey', () => {
  it('produces a base64 string that decodes to 32 bytes', () => {
    expect(Buffer.from(generateEncryptionKey(), 'base64')).toHaveLength(32)
  })
})
