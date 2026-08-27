import { addInternalDnc, type DncResult } from '../clients/compliance'

/**
 * SMS STOP → internal DNC (brief §M4, B.1 HTTP path). The ONE cross-slice write:
 * POST to Agent C's `/api/compliance/dnc/internal`. A 2xx is the success signal.
 * On failure the caller enqueues a `sms-stop-relay` retry — this write is legally
 * required and must never be silently dropped.
 */
export function handleStop(phone: string, correlationId?: string): Promise<DncResult> {
  return addInternalDnc({
    phone,
    reason: 'sms_stop_received',
    addedBy: 'sms-inbound-handler',
    correlationId,
  })
}
