import type { PrismaClient } from '@prisma/client'
import type { CompiledQuery } from './compiler'

// ─────────────────────────────────────────────────────────────────────────────
// Executor — turns a CompiledQuery into a full, org-scoped SELECT and runs it
// through Prisma's parameterized raw API ($queryRawUnsafe with positional
// params). The SQL string only ever contains allow-listed identifiers (from the
// compiler) and $N placeholders; every value travels as a bound param.
//
// buildSql() is pure and unit-tested without a DB. execute() is the thin DB
// boundary.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  organizationId: string
  // Raw SELECT list. Defaults to the whole lead row. Callers that need joins do
  // their own projection; the queue service selects the columns it needs.
  selectSql?: string
  orderBySql?: string
  limit?: number
  offset?: number
}

export interface BuiltSql {
  sql: string
  params: unknown[]
}

export function buildSql(
  compiled: CompiledQuery,
  options: ExecuteOptions
): BuiltSql {
  const params: unknown[] = [...compiled.params]
  const orgPlaceholder = `$${params.length + 1}`
  params.push(options.organizationId)

  const select = options.selectSql ?? 'lead.*'
  let sql =
    `SELECT ${select} FROM "Lead" lead ` +
    `WHERE lead."organizationId" = ${orgPlaceholder} AND (${compiled.whereSql})`

  if (options.orderBySql) sql += ' ' + options.orderBySql

  if (options.limit != null) {
    params.push(options.limit)
    sql += ` LIMIT $${params.length}`
  }
  if (options.offset != null && options.offset > 0) {
    params.push(options.offset)
    sql += ` OFFSET $${params.length}`
  }
  return { sql, params }
}

export function buildCountSql(
  compiled: CompiledQuery,
  organizationId: string
): BuiltSql {
  const params: unknown[] = [...compiled.params]
  const orgPlaceholder = `$${params.length + 1}`
  params.push(organizationId)
  const sql =
    `SELECT COUNT(*)::int AS count FROM "Lead" lead ` +
    `WHERE lead."organizationId" = ${orgPlaceholder} AND (${compiled.whereSql})`
  return { sql, params }
}

export async function execute<T = Record<string, unknown>>(
  compiled: CompiledQuery,
  prisma: PrismaClient,
  options: ExecuteOptions
): Promise<T[]> {
  const { sql, params } = buildSql(compiled, options)
  return prisma.$queryRawUnsafe<T[]>(sql, ...params)
}

export async function executeCount(
  compiled: CompiledQuery,
  prisma: PrismaClient,
  organizationId: string
): Promise<number> {
  const { sql, params } = buildCountSql(compiled, organizationId)
  const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
    sql,
    ...params
  )
  return rows[0]?.count ?? 0
}
