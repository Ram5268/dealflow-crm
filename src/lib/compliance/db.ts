import { prisma } from '@/lib/prisma'

// Compliance slice DB access. Re-exports the shell Prisma singleton so slice
// code has one import site, and the reader/writer interfaces the pipeline is
// built against (dependency injection for testability without a live DB).
export { prisma }

export type ComplianceDb = typeof prisma

// Resolve an injected DB (tests) or fall back to the shared Prisma singleton
// (production). Centralized so the "injected vs default" branch lives in ONE
// unit-tested place instead of once per module.
export function resolveDb<T>(injected: T | undefined): T {
  return injected ?? (prisma as unknown as T)
}
