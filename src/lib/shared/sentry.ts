import { logger } from '@/lib/logger'
import { getCorrelationId } from '@/lib/shell/correlationId'

// Thin Sentry seam. During isolated build SENTRY_DSN is unset, so every capture
// is a structured pino line. When a DSN is present at integration/prod, wire the
// real @sentry/nextjs client here — the call sites (captureException / warn)
// stay identical. Keeping this indirection means route handlers never import the
// SDK directly and correlationId is always attached.

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
