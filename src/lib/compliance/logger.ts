import { logger } from '@/lib/logger'
import { getCorrelationId } from '@/lib/shell/correlationId'

// pino child logger scoped to the compliance slice. Every log line is tagged
// `slice: "compliance"` and, when available, the active correlationId from
// async-local-storage — so a single dial's compliance decision is traceable
// end-to-end without threading the id through every function.
export const log = logger.child({ slice: 'compliance' })

// Bind an explicit correlationId (e.g. one parsed from a request header before
// ALS is established, or inside a background job).
export function logWith(correlationId?: string) {
  const cid = correlationId ?? getCorrelationId()
  return cid ? log.child({ correlationId: cid }) : log
}
