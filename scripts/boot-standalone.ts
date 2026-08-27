import 'dotenv/config'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { start as startMockCompliance } from '../contracts/mocks/compliance/server'

// ─────────────────────────────────────────────────────────────────────────────
// Gate 1 boot — the slice runs on its own with every B/C/D dependency mocked.
// Starts:
//   1. mock compliance server on :5555 (stands in for Agent C)
//   2. event listeners + pg-boss import worker (best-effort; USE_PGBOSS gates the
//      worker) so the crm_call/crm_message/crm_scrub consumers are live
//   3. Next.js dev server on :3000
// Polls /api/core-data/health until "ok"|"degraded", then prints SLICE READY.
//
// Note: this build uses the real DealFlow RO Railway DB (read-only) instead of a
// docker fixture; DEALFLOW_SYNC_STUB=1 short-circuits it for pure-isolation runs.
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_URL = 'http://localhost:3000/api/core-data/health'
const BOOT_TIMEOUT_MS = 180_000

let mockServer: ReturnType<typeof startMockCompliance> | null = null
let nextProc: ChildProcess | null = null

async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) {
        const body = (await res.json()) as { status: string }
        if (body.status === 'ok' || body.status === 'degraded') return true
      }
    } catch {
      // Next not up yet.
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

async function main() {
  // 1. Mock compliance.
  mockServer = startMockCompliance(Number(process.env.MOCK_COMPLIANCE_PORT) || 5555)

  // 2. Listeners + import worker (best-effort — a missing pgboss schema or LISTEN
  //    grant should not block the slice from serving HTTP).
  try {
    const { startListeners } = await import('../src/lib/core-data/events/listen')
    await startListeners()
  } catch (err) {
    console.warn('listeners not started:', (err as Error).message)
  }
  if (process.env.USE_PGBOSS === '1') {
    try {
      const { startImportWorker } = await import('../src/lib/core-data/importer/worker')
      await startImportWorker()
    } catch (err) {
      console.warn('import worker not started:', (err as Error).message)
    }
  }

  // 3. Next.js dev. Spawn the local binary directly — `pnpm` is only reachable
  //    via corepack here, so it isn't on the child's PATH.
  const nextBin = path.join(process.cwd(), 'node_modules', '.bin', 'next')
  nextProc = spawn(nextBin, ['dev'], { stdio: 'inherit', env: process.env })

  const healthy = await waitForHealth()
  if (!healthy) {
    console.error('BOOT FAILED: health did not report ready within timeout')
    await shutdown(1)
    return
  }
  console.log('SLICE READY')
}

async function shutdown(code: number) {
  try {
    mockServer?.close()
  } catch { /* noop */ }
  nextProc?.kill('SIGTERM')
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

main().catch(async (err) => {
  console.error('boot-standalone error:', err)
  await shutdown(1)
})
