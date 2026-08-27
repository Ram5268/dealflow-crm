import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * At-rest encryption for OAuth refresh tokens (brief §7 / §2.1).
 *
 * AES-256-GCM. The frozen `OAuthCredential` stores a single
 * `refreshTokenEncrypted` column (not the ciphertext/iv/tag triple the brief
 * originally sketched), so we PACK the GCM envelope into one string:
 *
 *     base64(iv) "." base64(authTag) "." base64(ciphertext)
 *
 * GCM's auth tag makes tampering detectable — a flipped byte in any segment
 * fails `final()`. Access tokens are short-lived and NOT encrypted (documented
 * call, brief §7).
 *
 * Failure-mode (brief §13): a missing/wrong `OAUTH_TOKEN_ENCRYPTION_KEY` must
 * refuse to boot rather than silently fall back to plaintext — `loadEncryptionKey`
 * throws, and the Gate-1 boot check calls it.
 */

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit nonce — the GCM standard
const KEY_BYTES = 32 // AES-256

/**
 * Load and validate the 32-byte key from a base64 env value. Throws on
 * missing/wrong-length key (never returns a weak/absent key).
 */
export function loadEncryptionKey(
  raw: string | undefined = process.env.OAUTH_TOKEN_ENCRYPTION_KEY,
): Buffer {
  if (!raw) {
    throw new Error(
      'OAUTH_TOKEN_ENCRYPTION_KEY is not set — refusing to handle OAuth tokens without at-rest encryption.',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `OAUTH_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    )
  }
  return key
}

/** Encrypt `plaintext` → packed `iv.tag.ciphertext` (all base64). */
export function encryptToken(
  plaintext: string,
  key: Buffer = loadEncryptionKey(),
): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.')
}

/** Decrypt a packed `iv.tag.ciphertext` envelope. Throws on tamper or wrong key. */
export function decryptToken(
  packed: string,
  key: Buffer = loadEncryptionKey(),
): string {
  const parts = packed.split('.')
  if (parts.length !== 3) {
    throw new Error('decryptToken: malformed ciphertext envelope (expected iv.tag.ct)')
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')

  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Convenience for local/dev setup — a fresh base64 key. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64')
}
