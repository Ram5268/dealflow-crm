// Brief 41.1 (F11): suite 2 (vitest.agent-d.config.ts) relies on every file
// mocking Prisma; nothing enforced that. A real PrismaClient uses
// DATABASE_URL_MAIN, and when the environment doesn't set it, Prisma 6 loads it
// on its own from the .env files recorded when `prisma generate` ran, which can
// be another checkout's. Any of them may point at the live CRM. So suite 2
// refuses to start unless that database is unset or a *_perf / *_test one: the
// same rule as suite 1, with no override.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'
import { assertTestDatabase } from '../../src/lib/shared/db-guard'

type Env = Record<string, string | undefined>
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// The DATABASE_URL_MAIN a PrismaClient would end up with: a value in the
// environment wins, even an empty one (Prisma's .env loading never overrides
// it); then the repo's .env, then prisma/.env.
export function prismaMainUrl(env: Env, envFiles: readonly string[]): string | undefined {
  if (env.DATABASE_URL_MAIN !== undefined) return env.DATABASE_URL_MAIN
  for (const text of envFiles) {
    const value = parse(text).DATABASE_URL_MAIN
    if (value !== undefined) return value
  }
  return undefined
}

export function assertSuite2Database(env: Env = process.env, root: string = REPO_ROOT): void {
  const envFiles = ['.env', path.join('prisma', '.env')]
    .map((file) => path.join(root, file))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
  const url = prismaMainUrl(env, envFiles)
  // No database at all: a stray real client couldn't connect anywhere.
  if (!url) return
  try {
    assertTestDatabase(url, 'suite 2 (vitest.agent-d.config.ts, DATABASE_URL_MAIN)', { allowOverride: false })
  } catch (err) {
    throw new Error(`${(err as Error).message} Suite 2 needs no database: run it with DATABASE_URL_MAIN set empty (DATABASE_URL_MAIN= ...).`)
  }
}

// What a test's real client would see: constructing one (it doesn't connect)
// makes Prisma load its recorded .env files into process.env, the same way.
// `clientModule` is only for tests/unit/db-guard.test.ts (Brief 50), which
// passes a client generated in a temporary checkout to test this real loading.
export async function loadPrismaEnv(clientModule = '@prisma/client'): Promise<void> {
  const { PrismaClient } = (await import(clientModule)) as typeof import('@prisma/client')
  new PrismaClient()
}

// The check, before and after Prisma's own .env loading. Whatever that loading
// added is then removed again, so no value from that file (credentials, send
// switches, keys) reaches the suite-2 workers: the check only needs to look.
export async function assertSuite2Environment(
  env: Env = process.env,
  root: string = REPO_ROOT,
  loadEnv: () => Promise<void> = loadPrismaEnv,
): Promise<void> {
  assertSuite2Database(env, root)
  const before = { ...env }
  try {
    await loadEnv()
    assertSuite2Database(env, root)
  } finally {
    for (const key of Object.keys(env)) if (!(key in before)) delete env[key]
    Object.assign(env, before)
  }
}

// vitest globalSetup: runs once, before any suite-2 file.
export default async function setup(): Promise<void> {
  await assertSuite2Environment()
}
