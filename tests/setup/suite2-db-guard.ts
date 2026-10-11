// Brief 41.1 (F11): suite 2 (vitest.agent-d.config.ts) relies on every file
// mocking Prisma; nothing enforced that. A real PrismaClient uses
// DATABASE_URL_MAIN, and when the environment doesn't set it, Prisma 6 loads it
// from the checkout's .env (or prisma/.env) on its own. A checkout's .env may
// point at the live CRM. So suite 2 refuses to start unless that database is
// unset or a *_perf / *_test one: the same rule as suite 1, with no override.
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
  assertTestDatabase(url, 'suite 2 (vitest.agent-d.config.ts, DATABASE_URL_MAIN)', { allowOverride: false })
}

// vitest globalSetup: runs once, before any suite-2 file.
export default function setup(): void {
  assertSuite2Database()
}
