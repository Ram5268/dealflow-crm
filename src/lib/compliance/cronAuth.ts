import crypto from 'node:crypto'
import { getEnv } from '@/lib/compliance/env'

// SHA-256 of a header value: every value becomes 32 bytes, so the comparison
// below never depends on, or gives away, the key's length.
const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest()

// Bearer-token gate for cron + circuit-resume endpoints. Rejects when the
// header is missing/wrong OR when CRON_SECRET is not configured at all (never
// allow an unauthenticated privileged call because the secret is unset).
// Brief 50 (PR 11), engineering precaution (open item 6.11): the header is
// compared in constant time (crypto.timingSafeEqual on the two digests), so
// how long a wrong key takes to refuse says nothing about how much of it was
// right. A secret of only spaces counts as unset, like an empty one.
export function isAuthorizedCron(req: Request): boolean {
  const { CRON_SECRET } = getEnv()
  if (!CRON_SECRET || CRON_SECRET.trim() === '') return false
  const supplied = req.headers.get('authorization')
  if (supplied === null) return false
  return crypto.timingSafeEqual(digest(supplied), digest(`Bearer ${CRON_SECRET}`))
}
