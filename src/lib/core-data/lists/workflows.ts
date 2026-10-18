// Brief 45 — saved Pipeline workflows ("Brownstone nurtures", "Expired hot
// leads"): a filter set plus its visible group columns, saved as a named tab
// [brief §5.6]. Stored as SavedView rows with type 'pipeline' (no schema
// change): sQuery = { version: 1, view, filters }, selectedFields = the group
// ids, sort = { key, dir } (or []). Every lead Smart View reader skips or
// refuses type 'pipeline', so a workflow is never parsed as one.
import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  PIPELINE_SORT_KEYS, PIPELINE_VIEWS, WORKFLOW_VIEW_TYPE,
  type PipelineFilters, type PipelineSort, type PipelineView, type WorkflowDTO,
} from './types'
import { pipelineFiltersSchema } from './pipeline'
import { TX, WORKFLOW_SCOPE, badRequest, conflict, findClash, lockScope, notFound, validName, type Tx } from './sql'

const storedQuerySchema = z.object({ version: z.literal(1), view: z.enum(PIPELINE_VIEWS), filters: pipelineFiltersSchema })
const sortSchema = z.strictObject({ key: z.enum(PIPELINE_SORT_KEYS), dir: z.enum(['asc', 'desc']) })

type Row = { id: string; name: string; sQuery: Prisma.JsonValue; selectedFields: Prisma.JsonValue; sort: Prisma.JsonValue }

/** Defensive: a malformed row still lists (with defaults) so Ryan can see and delete it. */
function toDTO(row: Row): WorkflowDTO {
  const stored = storedQuerySchema.safeParse(row.sQuery)
  const sort = sortSchema.safeParse(row.sort)
  const groupIds = Array.isArray(row.selectedFields) ? row.selectedFields.filter((g): g is string => typeof g === 'string') : []
  return {
    id: row.id,
    name: row.name,
    view: stored.success ? stored.data.view : 'board',
    filters: stored.success ? (stored.data.filters as PipelineFilters) : {},
    groupIds,
    sort: sort.success ? sort.data : null,
  }
}

const SELECT = { id: true, name: true, sQuery: true, selectedFields: true, sort: true } as const

// What a workflow stores in SavedView.sQuery (filters are plain strings).
const storedQuery = (view: PipelineView, filters: PipelineFilters) =>
  ({ version: 1, view, filters: { ...filters } }) as unknown as Prisma.InputJsonObject

export async function listWorkflows(organizationId: string, db: PrismaClient = prisma): Promise<WorkflowDTO[]> {
  const rows = await db.savedView.findMany({
    where: { organizationId, type: WORKFLOW_VIEW_TYPE },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: SELECT,
  })
  return rows.map(toDTO)
}

function validView(v: unknown): PipelineView {
  const r = z.enum(PIPELINE_VIEWS).safeParse(v)
  if (!r.success) throw badRequest('Pick a board or a table view.')
  return r.data
}

function validFilters(f: unknown): PipelineFilters {
  const r = pipelineFiltersSchema.safeParse(f ?? {})
  if (!r.success) throw badRequest("Those filters can't be saved: one isn't a Pipeline filter, or has an unknown value.")
  return r.data as PipelineFilters
}

function validSort(s: unknown): PipelineSort | null {
  if (s === null || s === undefined) return null
  const r = sortSchema.safeParse(s)
  if (!r.success) throw badRequest('Unknown sort.')
  return r.data
}

// The org's groups among `ids`, in the order given; unknown or another org's are dropped.
async function ownGroups(db: Tx, organizationId: string, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids) || ids.some((g) => typeof g !== 'string')) throw badRequest('groupIds must be a list of group ids.')
  const found = await db.leadGroup.findMany({ where: { organizationId, id: { in: ids as string[] } }, select: { id: true } })
  const ok = new Set(found.map((g) => g.id))
  return [...new Set(ids as string[])].filter((g) => ok.has(g))
}

async function assertWorkflowName(tx: Tx, organizationId: string, name: string, selfId: string | null): Promise<void> {
  const rows = await tx.savedView.findMany({ where: { organizationId, type: WORKFLOW_VIEW_TYPE }, select: { id: true, name: true } })
  const clash = findClash(rows, name, selfId)
  // [engineering precaution] two tabs with one name are confusing.
  if (clash) throw conflict(`A workflow named "${clash.name}" already exists.`)
}

export interface WorkflowInputLoose {
  name?: unknown
  view?: unknown
  filters?: unknown
  groupIds?: unknown
  sort?: unknown
}

export async function createWorkflow(organizationId: string, input: WorkflowInputLoose, db: PrismaClient = prisma): Promise<WorkflowDTO> {
  const name = validName(input.name)
  const view = validView(input.view)
  const filters = validFilters(input.filters)
  const sort = validSort(input.sort)
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, WORKFLOW_SCOPE)
    await assertWorkflowName(tx, organizationId, name, null)
    const groupIds = await ownGroups(tx, organizationId, input.groupIds ?? [])
    const row = await tx.savedView.create({
      data: {
        organizationId, name, type: WORKFLOW_VIEW_TYPE,
        sQuery: storedQuery(view, filters),
        selectedFields: groupIds,
        sort: (sort ?? []) as Prisma.InputJsonValue,
      },
      select: SELECT,
    })
    return toDTO(row)
  }, TX)
}

export async function updateWorkflow(organizationId: string, id: string, input: WorkflowInputLoose, db: PrismaClient = prisma): Promise<WorkflowDTO> {
  const name = input.name === undefined ? undefined : validName(input.name)
  return db.$transaction(async (tx) => {
    if (name !== undefined) await lockScope(tx, organizationId, WORKFLOW_SCOPE)
    const row = await tx.savedView.findFirst({ where: { id, organizationId, type: WORKFLOW_VIEW_TYPE }, select: SELECT })
    if (!row) throw notFound('Workflow')
    const current = toDTO(row)
    if (name !== undefined) await assertWorkflowName(tx, organizationId, name, id)
    const view = input.view === undefined ? current.view : validView(input.view)
    const filters = input.filters === undefined ? current.filters : validFilters(input.filters)
    const sort = input.sort === undefined ? current.sort : validSort(input.sort)
    const groupIds = input.groupIds === undefined ? current.groupIds : await ownGroups(tx, organizationId, input.groupIds)
    const updated = await tx.savedView.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        sQuery: storedQuery(view, filters),
        selectedFields: groupIds,
        sort: (sort ?? []) as Prisma.InputJsonValue,
      },
      select: SELECT,
    })
    return toDTO(updated)
  }, TX)
}

export async function deleteWorkflow(organizationId: string, id: string, db: PrismaClient = prisma): Promise<{ deleted: true }> {
  const { count } = await db.savedView.deleteMany({ where: { id, organizationId, type: WORKFLOW_VIEW_TYPE } })
  if (count === 0) throw notFound('Workflow')
  return { deleted: true }
}
