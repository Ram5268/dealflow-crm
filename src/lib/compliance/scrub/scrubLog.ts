// Append-only forensic log of every compliance decision — the TCPA audit
// trail. NEVER skip a ScrubLog write on a fail-closed path; the log IS the
// evidence. Bulk-friendly: one createMany per batch (Ryan's Railway is ~90ms
// per awaited .create(), so N sequential creates would blow the perf budget).

export type ScrubResult = 'clean' | 'blocked' | 'error'

export type ScrubOperation =
  | 'check-federal'
  | 'check-state'
  | 'check-litigator'
  | 'check-window'
  | 'check-internal'
  | 'check-holiday'
  | 'check-mobile-line'

export interface ScrubLogInput {
  phone: string
  contactPhoneId?: string | null
  operation: ScrubOperation
  result: ScrubResult
  detail?: unknown
}

export interface ScrubLogDb {
  scrubLog: { createMany: (args: any) => Promise<{ count: number }> }
}

export async function writeScrubLogs(
  orgId: string,
  rows: ScrubLogInput[],
  db: ScrubLogDb
): Promise<void> {
  if (rows.length === 0) return
  await db.scrubLog.createMany({
    data: rows.map((r) => ({
      organizationId: orgId,
      phone: r.phone,
      contactPhoneId: r.contactPhoneId ?? null,
      operation: r.operation,
      result: r.result,
      detail: (r.detail ?? undefined) as any,
    })),
  })
}
