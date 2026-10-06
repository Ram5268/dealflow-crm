import { addInternalDnc, type AddInternalDncResult } from '@/lib/compliance/dnc/internal'

/**
 * SMS STOP → internal DNC. Brief 41 (H12): written in-process. It used to be an
 * HTTP self-call to the compliance route with no Basic-auth credentials, at a
 * URL that didn't match the compliance base, so a STOP never reached the list.
 * Throws on failure: the webhook then answers non-2xx instead of dropping a
 * legally required opt-out.
 */
export function handleStop(orgId: string, phone: string): Promise<AddInternalDncResult> {
  return addInternalDnc(orgId, {
    phone,
    reason: 'sms_stop_received',
    addedBy: 'sms-inbound-handler',
  })
}
