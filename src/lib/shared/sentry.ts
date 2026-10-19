import { logger } from '@/lib/logger'
import { getCorrelationId } from '@/lib/shell/correlationId'

// Thin Sentry seam. Every capture is a structured pino line (correlationId
// attached), which lands in the server's logs. Keeping this indirection means
// route handlers never import the SDK directly and correlationId is always
// attached.
//
// Sentry itself is NOT wired (Brief 50 PR 2, 2026-10-19): no SENTRY_DSN is set
// in any settings file we can see, and Vercel's settings can't be seen from
// here. @sentry/nextjs is installed but never initialised, and setting a DSN
// alone turns nothing on (sentryEnabled() only reports whether one is set;
// nothing reads it). To turn Sentry on later: set SENTRY_DSN in Vercel,
// initialise the SDK (instrumentation.ts with onRequestError for server
// errors, instrumentation-client.ts for the browser), and un-comment the two
// calls below; the call sites (captureException / captureWarning) stay
// identical. The error pages (src/app/error.tsx, src/app/global-error.tsx) run
// in the browser and log to its console; Next logs the server side of the
// same error under the digest they show as "Reference".

const DSN = process.env.SENTRY_DSN

interface CaptureContext {
  dependency?: string
  event?: string
  [key: string]: unknown
}

export function captureException(err: unknown, context: CaptureContext = {}): void {
  const correlationId = getCorrelationId()
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : undefined
  logger.error({ correlationId, ...context, err: message, stack }, 'exception')
  // if (DSN) Sentry.captureException(err, { tags: { correlationId }, extra: context })
}

export function captureWarning(message: string, context: CaptureContext = {}): void {
  const correlationId = getCorrelationId()
  logger.warn({ correlationId, ...context }, message)
  // if (DSN) Sentry.captureMessage(message, { level: 'warning', tags: { correlationId }, extra: context })
}

export function sentryEnabled(): boolean {
  return !!DSN
}
