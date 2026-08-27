import 'dotenv/config'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { start as startMockCompliance } from '../contracts/mocks/compliance/server'

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSED BOOT — all four slices on the shared Railway DB.
//
// Runs AFTER integration merge (A → C → B → D), when every slice's routes live
// in one Next app. Extends scripts/boot-standalone.ts (Agent A's Gate-1 boot):
//   1. compliance    — real Agent C if COMPLIANCE_BASE_URL is remote, else the
//                      A-owned mock on :5555 (stand-in until C's keys land)
//   2. listeners     — crm_call / crm_message / crm_scrub consumers (A + D emitters)
//   3. workers       — pg-boss import worker (A) + comms/dial workers (B/D) when
//                      USE_PGBOSS=1
//   4. next dev       — one server on :3000 serving every slice's routes
//   5. health matrix — polls each slice's health endpoint, prints a table, and
//                      exits non-zero if ANY slice is unhealthy (CI-friendly)
//
// This is the integration-prep draft (Agent A). Endpoints/ports are read from env
// with the SHAs Ryan pinned as defaults, so the real values drop in without a code
// edit. Ownership of the B/C/D worker bootstraps transfers at integration — the
// dynamic import()s below are best-effort and warn (not fail) if a module is absent,
// exactly like boot-standalone, so this still boots A-only before the other merges.
// ─────────────────────────────────────────────────────────────────────────────

const BOOT_TIMEOUT_MS = Number(process.env.BOOT_ALL_TIMEOUT_MS) || 180_000
const BASE = process.env.BOOT_ALL_BASE_URL || 'http://localhost:3000'

// Each slice contributes one PRIMARY health endpoint (gates the matrix) plus any
// number of secondary endpoints (surfaced in the table, non-gating). Override any
// URL via env so the pinned SHAs' real paths win at integration without a re-edit.
type Probe = { label: string; url: string; gating: boolean }
type Slice = { slice: string; owner: string; sha: string; probes: Probe[] }

const SLICES: Slice[] = [
  {
    slice: 'A · Core Data',
    owner: 'agent-a',
    sha: process.env.SHA_A || '55a7272',
    probes: [
      { label: 'health', url: `${BASE}/api/core-data/health`, gating: true },
    ],
  },
  {
    slice: 'B · Dialer',
    owner: 'agent-b',
    sha: process.env.SHA_B || 'e215469',
    probes: [
      { label: 'health', url: process.env.B_HEALTH_URL || `${BASE}/api/dial-session/health`, gating: true },
      { label: 'webhook/voice', url: process.env.B_WEBHOOK_VOICE_URL || `${BASE}/api/webhook/voice`, gating: false },
      { label: 'webhook/status', url: process.env.B_WEBHOOK_STATUS_URL || `${BASE}/api/webhook/status`, gating: false },
    ],
  },
  {
    slice: 'C · Compliance',
    owner: 'agent-c',
    sha: process.env.SHA_C || 'fd3d28d',
    probes: [
      { label: 'health', url: process.env.C_HEALTH_URL || `${BASE}/api/compliance/health`, gating: true },
    ],
  },
  {
    slice: 'D · Comms',
    owner: 'agent-d',
    sha: process.env.SHA_D || 'pending-M3',
    probes: [
      { label: 'health', url: process.env.D_HEALTH_URL || `${BASE}/api/comms/health`, gating: true },
      { label: 'mock/sms', url: process.env.D_MOCK_SMS_URL || `${BASE}/api/comms/_mock/sms/health`, gating: false },
      { label: 'mock/email', url: process.env.D_MOCK_EMAIL_URL || `${BASE}/api/comms/_mock/email/health`, gating: false },
      { label: 'mock/voice', url: process.env.D_MOCK_VOICE_URL || `${BASE}/api/comms/_mock/voice/health`, gating: false },
      { label: 'mock/webhook', url: process.env.D_MOCK_WEBHOOK_URL || `${BASE}/api/comms/_mock/webhook/health`, gating: false },
    ],
  },
]

let mockServer: ReturnType<typeof startMockCompliance> | null = null
let nextProc: ChildProcess | null = null

type ProbeResult = { label: string; gating: boolean; ok: boolean; status: string; detail: string }

async function probeOnce(url: string): Promise<{ ok: boolean; status: string; detail: string }> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, status: `HTTP ${res.status}`, detail: '' }
    // Health endpoints return JSON { status: "ok" | "degraded" | ... }; webhook
    // probes may return 200 with no/opaque body — a 2xx is enough for those.
    let body: { status?: string } = {}
    try {
      body = (await res.json()) as { status?: string }
    } catch {
      return { ok: true, status: 'ok', detail: '(non-json 2xx)' }
    }
    const s = body.status ?? 'ok'
    return { ok: s === 'ok' || s === 'degraded', status: s, detail: '' }
  } catch (err) {
    return { ok: false, status: 'unreachable', detail: (err as Error).message }
  }
}

// Poll a slice's GATING probe until healthy or the deadline passes; secondary
// probes are sampled once at the end (they don't gate readiness).
async function waitForSlice(s: Slice, deadline: number): Promise<ProbeResult[]> {
  const gating = s.probes.filter((p) => p.gating)
  const secondary = s.probes.filter((p) => !p.gating)
  const gatingResults: ProbeResult[] = []
  for (const p of gating) {
    let last = { ok: false, status: 'unreachable', detail: '' }
    while (Date.now() < deadline) {
      last = await probeOnce(p.url)
      if (last.ok) break
      await new Promise((r) => setTimeout(r, 2000))
    }
    gatingResults.push({ label: p.label, gating: true, ...last })
  }
  const secondaryResults: ProbeResult[] = []
  for (const p of secondary) {
    const r = await probeOnce(p.url)
    secondaryResults.push({ label: p.label, gating: false, ...r })
  }
  return [...gatingResults, ...secondaryResults]
}

function printMatrix(rows: { s: Slice; results: ProbeResult[] }[]): boolean {
  const line = '─'.repeat(72)
  console.log(`\n${line}`)
  console.log('COMPOSED BOOT — SLICE HEALTH MATRIX')
  console.log(line)
  let allGatingUp = true
  for (const { s, results } of rows) {
    const gatingOk = results.filter((r) => r.gating).every((r) => r.ok)
    if (!gatingOk) allGatingUp = false
    const badge = gatingOk ? '✅' : '❌'
    console.log(`\n${badge}  ${s.slice.padEnd(20)} ${s.owner}@${s.sha}`)
    for (const r of results) {
      const mark = r.ok ? ' ok ' : 'FAIL'
      const tag = r.gating ? '' : '  (non-gating)'
      const extra = r.detail ? `  ${r.detail}` : ''
      console.log(`     [${mark}] ${r.label.padEnd(16)} ${r.status}${tag}${extra}`)
    }
  }
  console.log(`\n${line}`)
  console.log(allGatingUp ? 'ALL SLICES READY' : 'BOOT INCOMPLETE — one or more gating health checks failed')
  console.log(`${line}\n`)
  return allGatingUp
}

async function main() {
  // 1. Compliance — mock unless COMPLIANCE_BASE_URL points off localhost:5555
  //    (i.e. the real Agent C is wired). Same gate boot-standalone uses.
  const complianceIsMock =
    !process.env.COMPLIANCE_BASE_URL || process.env.COMPLIANCE_BASE_URL.includes('localhost:5555')
  if (complianceIsMock) {
    mockServer = startMockCompliance(Number(process.env.MOCK_COMPLIANCE_PORT) || 5555)
    console.log('compliance: mock on :5555 (real Agent C not wired)')
  } else {
    console.log(`compliance: real Agent C at ${process.env.COMPLIANCE_BASE_URL}`)
  }

  // 2. Listeners (A + D consumers). Best-effort — a missing module before the
  //    D merge should warn, not abort.
  try {
    const { startListeners } = await import('../src/lib/core-data/events/listen')
    await startListeners()
    console.log('listeners: crm_call / crm_message / crm_scrub live')
  } catch (err) {
    console.warn('listeners not started:', (err as Error).message)
  }

  // 3. Workers — pg-boss import worker (A) + B/D workers when their modules exist.
  //    All gated behind USE_PGBOSS and wrapped best-effort per boot-standalone.
  if (process.env.USE_PGBOSS === '1') {
    // Specifiers are held as variables (not literals) so tsc doesn't try to
    // resolve the B/D worker modules that only exist after their merges.
    const workerModules = [
      '../src/lib/core-data/importer/worker',      // A — import commit
      '../src/lib/dialer/worker',                  // B — dial loop / pacing (post-merge)
      '../src/lib/comms/worker',                   // D — sequence tick / send (post-merge)
    ]
    for (const mod of workerModules) {
      try {
        const spec = mod as string
        const m = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>
        const starter = Object.values(m).find((v) => typeof v === 'function') as
          | (() => Promise<void>)
          | undefined
        if (starter) {
          await starter()
          console.log(`worker: started ${mod}`)
        }
      } catch (err) {
        console.warn(`worker not started (${mod}):`, (err as Error).message)
      }
    }
  }

  // 4. One Next server for every slice's routes. Spawn the local binary directly —
  //    pnpm is corepack-only here and isn't on the child's PATH.
  const nextBin = path.join(process.cwd(), 'node_modules', '.bin', 'next')
  nextProc = spawn(nextBin, ['dev'], { stdio: 'inherit', env: process.env })

  // 5. Health matrix — poll every slice's gating endpoint, then print.
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  const rows = []
  for (const s of SLICES) {
    const results = await waitForSlice(s, deadline)
    rows.push({ s, results })
  }
  const allUp = printMatrix(rows)
  if (!allUp) {
    await shutdown(1)
    return
  }
  console.log('COMPOSED SLICE READY')
}

async function shutdown(code: number) {
  try {
    mockServer?.close()
  } catch {
    /* noop */
  }
  nextProc?.kill('SIGTERM')
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

main().catch(async (err) => {
  console.error('boot-all error:', err)
  await shutdown(1)
})
