import { getEnv } from '@/lib/compliance/env'

// Bearer-token gate for cron + circuit-resume endpoints. Rejects when the
// header is missing/wrong OR when CRON_SECRET is not configured at all (never
// allow an unauthenticated privileged call because the secret is unset).
export function isAuthorizedCron(req: Request): boolean {
  const { CRON_SECRET } = getEnv()
  if (!CRON_SECRET) return false
  return req.headers.get('authorization') === `Bearer ${CRON_SECRET}`
}
