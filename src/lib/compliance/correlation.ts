import { CORRELATION_HEADER, newCorrelationId } from '@/lib/shell/correlationId'

// Every compliance endpoint requires an x-correlation-id. The shell middleware
// mints one if absent, but route handlers may run in contexts (tests, cron)
// where the header isn't set — so we resolve-or-mint here and echo it back on
// the response.
export function correlationIdFrom(req: Request): string {
  return req.headers.get(CORRELATION_HEADER) ?? newCorrelationId()
}

export { CORRELATION_HEADER }
