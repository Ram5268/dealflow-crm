/**
 * HTTP client for Agent C's compliance endpoints (brief §9). The ONE cross-slice
 * write in the whole system goes through here (`/dnc/internal`).
 *
 * - `scrub` is FAIL-CLOSED: any timeout/error/non-2xx → every phone treated as
 *   NOT callable with `compliance_unavailable` — the one service-level REASON_CODE
 *   (Agent C's PR#2 enum). Like Agent A's compliance-bridge, D cannot attribute the
 *   failure to a specific vendor when Agent C itself is unreachable, so it emits the
 *   service-level code rather than any `vendor_error_*` variant.
 * - `addInternalDnc` tolerates C's response shape: maps `dncId → id`, defaults
 *   `added=true` when absent, so a subset response never breaks the STOP flow.
 *
 * Base URL from `COMPLIANCE_BASE_URL` (the compliance mock in isolation, Agent C's
 * real service in prod via a relative/absolute URL).
 */

const FAIL_CLOSED_REASON = 'compliance_unavailable'

function baseUrl(): string {
  return process.env.COMPLIANCE_BASE_URL ?? 'http://localhost:4001'
}

function headers(correlationId?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (correlationId) h['x-correlation-id'] = correlationId
  return h
}

export interface ScrubResult {
  phone: string
  callable: boolean
  reasons: string[]
}

function failClosed(phones: string[]): ScrubResult[] {
  return phones.map((phone) => ({
    phone,
    callable: false,
    reasons: [FAIL_CLOSED_REASON],
  }))
}

export async function scrub(
  phones: string[],
  opts: { contactPhoneIds?: string[]; correlationId?: string } = {},
): Promise<ScrubResult[]> {
  if (phones.length === 0) return []
  try {
    const res = await fetch(`${baseUrl()}/scrub`, {
      method: 'POST',
      headers: headers(opts.correlationId),
      body: JSON.stringify({ phones, contactPhoneIds: opts.contactPhoneIds }),
    })
    if (!res.ok) return failClosed(phones)
    const data = (await res.json()) as { results?: ScrubResult[] }
    if (!Array.isArray(data.results)) return failClosed(phones)
    return data.results
  } catch {
    return failClosed(phones)
  }
}

/** Single-phone convenience. Fail-closed. */
export async function isCallable(
  phone: string,
  opts: { contactPhoneId?: string; correlationId?: string } = {},
): Promise<ScrubResult> {
  const [result] = await scrub([phone], {
    contactPhoneIds: opts.contactPhoneId ? [opts.contactPhoneId] : undefined,
    correlationId: opts.correlationId,
  })
  return result ?? { phone, callable: false, reasons: [FAIL_CLOSED_REASON] }
}

export interface DncResult {
  id: string
  phone: string
  source: string
  addedAt: string
  added: boolean
}

/**
 * Add a phone to Agent C's internal DNC ledger (the STOP path). A 201/2xx is the
 * success signal. Response shape is normalized tolerantly (merged or legacy).
 * Throws on non-2xx so the caller can enqueue a retry (this write is legally
 * required — never silently dropped).
 */
export async function addInternalDnc(input: {
  phone: string
  reason?: string
  addedBy?: string
  correlationId?: string
}): Promise<DncResult> {
  const res = await fetch(`${baseUrl()}/dnc/internal`, {
    method: 'POST',
    headers: headers(input.correlationId),
    body: JSON.stringify({
      phone: input.phone,
      source: 'internal',
      reason: input.reason,
      addedBy: input.addedBy,
      correlationId: input.correlationId,
    }),
  })
  if (!res.ok) {
    throw new Error(`compliance /dnc/internal failed: HTTP ${res.status}`)
  }
  const data = (await res.json()) as Partial<DncResult> & { dncId?: string }
  return {
    id: data.id ?? data.dncId ?? '',
    phone: data.phone ?? input.phone,
    source: data.source ?? 'internal',
    addedAt: data.addedAt ?? new Date().toISOString(),
    added: data.added ?? true,
  }
}
