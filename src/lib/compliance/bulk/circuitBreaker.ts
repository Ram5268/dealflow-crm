// In-process vendor circuit-breaker. When a vendor's error rate exceeds 20%
// over a rolling 5-minute window, the circuit OPENS and every subsequent scrub
// of that type fails-closed (reasons: circuit_open_dnc / circuit_open_litigator)
// until an operator un-halts it via POST /api/compliance/circuit/resume.
//
// This prevents a flapping vendor from silently letting calls through OR from
// burning the whole 25k bulk-scrub against a dead endpoint. State is per Node
// worker (single-seat MVP; no shared store needed).

export type VendorKind = 'dnc' | 'litigator'

const WINDOW_MS = 5 * 60 * 1000
const MIN_SAMPLES = 5 // don't trip on a tiny early sample
const ERROR_THRESHOLD = 0.2 // > 20% errors over the window => open

interface Sample {
  at: number
  ok: boolean
}

class CircuitBreaker {
  private samples: Sample[] = []
  private open = false

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS
    if (this.samples.length && this.samples[0].at < cutoff) {
      this.samples = this.samples.filter((s) => s.at >= cutoff)
    }
  }

  record(ok: boolean, now: number = Date.now()): void {
    this.prune(now)
    this.samples.push({ at: now, ok })
    if (!this.open && this.samples.length >= MIN_SAMPLES) {
      const errors = this.samples.reduce((n, s) => n + (s.ok ? 0 : 1), 0)
      if (errors / this.samples.length > ERROR_THRESHOLD) this.open = true
    }
  }

  isOpen(now: number = Date.now()): boolean {
    this.prune(now)
    return this.open
  }

  resume(): void {
    this.open = false
    this.samples = []
  }

  state(): 'open' | 'closed' {
    return this.open ? 'open' : 'closed'
  }
}

const breakers: Record<VendorKind, CircuitBreaker> = {
  dnc: new CircuitBreaker(),
  litigator: new CircuitBreaker(),
}

export function recordVendorResult(kind: VendorKind, ok: boolean, now?: number): void {
  breakers[kind].record(ok, now)
}

export function isCircuitOpen(kind: VendorKind, now?: number): boolean {
  return breakers[kind].isOpen(now)
}

// Un-halt one or all circuits (operator action via /circuit/resume).
export function resumeCircuit(target: VendorKind | 'all'): VendorKind[] {
  const kinds: VendorKind[] = target === 'all' ? ['dnc', 'litigator'] : [target]
  for (const k of kinds) breakers[k].resume()
  return kinds
}

export function getCircuitState(): { dnc: 'open' | 'closed'; litigator: 'open' | 'closed' } {
  return { dnc: breakers.dnc.state(), litigator: breakers.litigator.state() }
}

// Test seam.
export function resetCircuitsForTest(): void {
  breakers.dnc.resume()
  breakers.litigator.resume()
}
