import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { compile, compileOrderBy, type CompileContext } from '@/lib/core-data/query-dsl/compiler'
import { execute, executeCount } from '@/lib/core-data/query-dsl/executor'
import { sQuerySchema, sortSpecSchema } from '@/lib/core-data/query-dsl/schema'

// Close-style ad-hoc s_query executor. Paginated via an opaque offset cursor.
const searchSchema = z.object({
  sQuery: sQuerySchema,
  sort: sortSpecSchema.default([]),
  limit: z.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
  includeCount: z.boolean().default(false),
})

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
}
function decodeCursor(cursor?: string): number {
  if (!cursor) return 0
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return typeof o === 'number' && o >= 0 ? o : 0
  } catch {
    return 0
  }
}

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, searchSchema)

  const defs = await prisma.customFieldDefinition.findMany({
    where: { organizationId },
    select: { id: true, type: true },
  })
  const customFieldTypes = Object.fromEntries(defs.map((d) => [d.id, d.type])) as CompileContext['customFieldTypes']

  const compiled = compile(body.sQuery, { organizationId, customFieldTypes })
  const offset = decodeCursor(body.cursor)
  const rows = await execute(compiled, prisma, {
    organizationId,
    orderBySql: compileOrderBy(body.sort),
    limit: body.limit + 1,
    offset,
  })
  const hasMore = rows.length > body.limit
  const page = hasMore ? rows.slice(0, body.limit) : rows

  const count = body.includeCount ? await executeCount(compiled, prisma, organizationId) : undefined

  return json(
    {
      results: page,
      nextCursor: hasMore ? encodeCursor(offset + body.limit) : null,
      ...(count !== undefined ? { totalCount: count } : {}),
    },
    correlationId
  )
})
