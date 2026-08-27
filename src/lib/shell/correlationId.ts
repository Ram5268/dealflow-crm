import { AsyncLocalStorage } from 'node:async_hooks'

// Correlation-id propagation. A correlation id ties together every log line,
// event payload, and downstream call spawned by a single inbound request.
//
// The Next.js middleware (../../middleware.ts) reads or mints the
// `x-correlation-id` request header. Server-side code (route handlers, jobs)
// runs its work inside `runWithCorrelationId` so that `getCorrelationId()`
// resolves the active id anywhere in the async call tree without threading it
// through every function signature.
export const CORRELATION_HEADER = 'x-correlation-id'

const storage = new AsyncLocalStorage<string>()

export function newCorrelationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackId()
}

export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return storage.run(id, fn)
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()
}

let fallbackCounter = 0

function fallbackId(): string {
  // Fallback for runtimes without crypto.randomUUID. Edge-safe: no process.*
  // (middleware runs on the Edge Runtime). Node 22 and Edge both have
  // crypto.randomUUID, so this branch is effectively unreachable in practice.
  fallbackCounter += 1
  return 'cid-' + Math.abs(hash(`${Date.now()}-${fallbackCounter}`)).toString(36)
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i)
  return h
}
