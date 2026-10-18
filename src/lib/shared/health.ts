import { prisma } from '@/lib/prisma'
import { dealflowRoConfigured, roQuery } from '@/lib/core-data/dealflow-sync/ro-client'

// Pure-ish health probes, extracted from the route so they are unit-testable and
// reusable by boot-standalone. Each check is best-effort and never throws.

export type CheckState = 'ok' | 'degraded' | 'down' | 'stale' | 'skipped'

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down'
  checks: {
    db: CheckState
    dealflowRo: CheckState
    anthropic: CheckState
    r2: CheckState
  }
  timestamp: string
}

async function checkDb(): Promise<CheckState> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    return 'ok'
  } catch {
    return 'down'
  }
}

async function checkDealflowRo(): Promise<CheckState> {
  if (process.env.DEALFLOW_SYNC_STUB === '1') return 'skipped'
  if (!dealflowRoConfigured()) return 'skipped'
  try {
    // Brief 41.2 (PR F), engineering precaution: through the read-only client,
    // which runs it inside BEGIN READ ONLY … ROLLBACK and releases its client.
    // The raw client this took was never released (known issue M2), from the
    // pool of 4 the DealFlow sync also uses.
    await roQuery('SELECT 1')
    return 'ok'
  } catch {
    return 'down'
  }
}

function checkAnthropic(): CheckState {
  // No live HEAD in isolated build; presence of a key is the readiness signal.
  return process.env.ANTHROPIC_API_KEY ? 'ok' : 'skipped'
}

function checkR2(): CheckState {
  return process.env.R2_ACCESS_KEY_ID ? 'ok' : 'skipped'
}

export async function getHealth(): Promise<HealthReport> {
  const [db, dealflowRo] = await Promise.all([checkDb(), checkDealflowRo()])
  const anthropic = checkAnthropic()
  const r2 = checkR2()

  let status: HealthReport['status'] = 'ok'
  if (db === 'down') status = 'down'
  else if (dealflowRo === 'down') status = 'degraded'

  return {
    status,
    checks: { db, dealflowRo, anthropic, r2 },
    timestamp: new Date().toISOString(),
  }
}
