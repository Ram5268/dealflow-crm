import 'dotenv/config'
import { promises as fs } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { assertTestDatabase, scriptArgs } from '../src/lib/shared/db-guard'

// Restores a logical backup produced by scripts/backup.ts. Idempotent: upserts
// by primary key so a restore can be re-run. It never deletes. Usage:
//   pnpm tsx scripts/restore-from-backup.ts backups/backup-<stamp>.json
//   (add --i-mean-live, anywhere, to restore into a non-test database)
// REQUIRED for Gate 1 sign-off (tested once). Production physical restores use
// `pg_restore` from the pg_dump artifact.

// Brief 41 (H11): a restore overwrites rows, so it refuses a live
// DATABASE_URL_MAIN unless run with --i-mean-live (a deliberate live restore).
assertTestDatabase(process.env.DATABASE_URL_MAIN, 'restore-from-backup (DATABASE_URL_MAIN)', { allowOverride: true })

const prisma = new PrismaClient()

// Rows come from arbitrary backup JSON, so they are untyped here; each caller
// hands them to the matching Prisma delegate. `any` is deliberate for a restore.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function upsertAll(
  rows: any[],
  upsert: (row: any) => Promise<unknown>
): Promise<number> {
  for (const r of rows) await upsert(r)
  return rows.length
}

// ─── Brief 50 PR 7 (open item 6.12): folders, lists, groups, memberships ─────
// Ryan's folders, lists and groups, and who is on each (Brief 45), which
// backup.ts saves. Restored in key order (folders → lists → groups →
// memberships), all four in one transaction (all of it or none of it), by
// key with ON CONFLICT, so a second run changes nothing. Organization by
// organization [engineering precaution: every query in the CRM is per
// organization]:
//   - a folder, list or group is written only into its own organization: a
//     backup row whose id belongs to another organization's row is skipped,
//     never moved or overwritten;
//   - a list keeps its folder only when the folder is in the list's
//     organization (otherwise it is restored outside folders);
//   - someone is put back on a list or in a group only when that list or
//     group, and the person, are in the organization the backup gives the
//     list or group.
// Timestamps are kept as saved (backup.ts writes UTC; the columns hold UTC).

const CHUNK = 1_000
const ts = 'timestamp(3)'

const FOLDERS_SQL = `
  INSERT INTO "Folder" (id, "organizationId", name, "sortOrder", "createdAt", "updatedAt")
  SELECT r.id, r."organizationId", r.name, r."sortOrder", r."createdAt", r."updatedAt"
  FROM jsonb_to_recordset($1::jsonb) AS r(id text, "organizationId" text, name text, "sortOrder" int, "createdAt" ${ts}, "updatedAt" ${ts})
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "sortOrder" = EXCLUDED."sortOrder",
    "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
  WHERE "Folder"."organizationId" = EXCLUDED."organizationId"
  RETURNING id`

const LISTS_SQL = `
  INSERT INTO "CallList" (id, "organizationId", name, "folderId", source, "sortOrder", "archivedAt", "createdAt", "updatedAt")
  SELECT r.id, r."organizationId", r.name, f.id, r.source, r."sortOrder", r."archivedAt", r."createdAt", r."updatedAt"
  FROM jsonb_to_recordset($1::jsonb) AS r(id text, "organizationId" text, name text, "folderId" text, source text,
    "sortOrder" int, "archivedAt" ${ts}, "createdAt" ${ts}, "updatedAt" ${ts})
  LEFT JOIN "Folder" f ON f.id = r."folderId" AND f."organizationId" = r."organizationId"
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "folderId" = EXCLUDED."folderId", source = EXCLUDED.source,
    "sortOrder" = EXCLUDED."sortOrder", "archivedAt" = EXCLUDED."archivedAt",
    "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
  WHERE "CallList"."organizationId" = EXCLUDED."organizationId"
  RETURNING id, "folderId"`

const GROUPS_SQL = `
  INSERT INTO "LeadGroup" (id, "organizationId", name, color, "sortOrder", "createdAt", "updatedAt")
  SELECT r.id, r."organizationId", r.name, r.color, r."sortOrder", r."createdAt", r."updatedAt"
  FROM jsonb_to_recordset($1::jsonb) AS r(id text, "organizationId" text, name text, color text, "sortOrder" int, "createdAt" ${ts}, "updatedAt" ${ts})
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, "sortOrder" = EXCLUDED."sortOrder",
    "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
  WHERE "LeadGroup"."organizationId" = EXCLUDED."organizationId"
  RETURNING id`

// $1 rows carry the organization the backup gives their list (or group).
const LIST_MEMBERS_SQL = `
  INSERT INTO "ListMembership" ("listId", "leadId", "addedAt", "addedBy")
  SELECT r."listId", r."leadId", r."addedAt", r."addedBy"
  FROM jsonb_to_recordset($1::jsonb) AS r("listId" text, "leadId" text, "addedAt" ${ts}, "addedBy" text, "organizationId" text)
  JOIN "CallList" l ON l.id = r."listId" AND l."organizationId" = r."organizationId"
  JOIN "Lead" d ON d.id = r."leadId" AND d."organizationId" = r."organizationId"
  ON CONFLICT ("listId", "leadId") DO UPDATE SET "addedAt" = EXCLUDED."addedAt", "addedBy" = EXCLUDED."addedBy"
  RETURNING 1`

const GROUP_MEMBERS_SQL = `
  INSERT INTO "LeadGroupMembership" ("groupId", "leadId", "addedAt", "addedBy")
  SELECT r."groupId", r."leadId", r."addedAt", r."addedBy"
  FROM jsonb_to_recordset($1::jsonb) AS r("groupId" text, "leadId" text, "addedAt" ${ts}, "addedBy" text, "organizationId" text)
  JOIN "LeadGroup" g ON g.id = r."groupId" AND g."organizationId" = r."organizationId"
  JOIN "Lead" d ON d.id = r."leadId" AND d."organizationId" = r."organizationId"
  ON CONFLICT ("groupId", "leadId") DO UPDATE SET "addedAt" = EXCLUDED."addedAt", "addedBy" = EXCLUDED."addedBy"
  RETURNING 1`

type Tx = Pick<PrismaClient, '$queryRawUnsafe'>

// Runs `sql` over `rows`, CHUNK at a time; returns every row it gives back.
async function inChunks<T>(tx: Tx, sql: string, rows: unknown[]): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < rows.length; i += CHUNK) out.push(...(await tx.$queryRawUnsafe<T[]>(sql, JSON.stringify(rows.slice(i, i + CHUNK)))))
  return out
}

interface ListsRestored {
  folders: number
  lists: number
  groups: number
  listMembers: number
  groupMembers: number
  /** Rows not written (another organization's id, or across organizations). */
  skipped: { folders: number; lists: number; groups: number; listMembers: number; groupMembers: number }
  /** Lists put back outside folders: their folder isn't in their organization. */
  outsideFolders: number
}

export async function restoreListsAndGroups(db: PrismaClient, data: Record<string, any[] | undefined>): Promise<ListsRestored> {
  const folders = data.folders ?? []
  const lists = data.callLists ?? []
  const groups = data.leadGroups ?? []
  const listOrg = new Map(lists.map((l) => [l.id as string, l.organizationId as string]))
  const groupOrg = new Map(groups.map((g) => [g.id as string, g.organizationId as string]))
  const listMembers = (data.listMemberships ?? []).map((m) => ({ ...m, organizationId: listOrg.get(m.listId) ?? null }))
  const groupMembers = (data.leadGroupMemberships ?? []).map((m) => ({ ...m, organizationId: groupOrg.get(m.groupId) ?? null }))
  return db.$transaction(
    async (tx) => {
      const f = await inChunks<{ id: string }>(tx, FOLDERS_SQL, folders)
      const l = await inChunks<{ id: string; folderId: string | null }>(tx, LISTS_SQL, lists)
      const g = await inChunks<{ id: string }>(tx, GROUPS_SQL, groups)
      const lm = await inChunks(tx, LIST_MEMBERS_SQL, listMembers)
      const gm = await inChunks(tx, GROUP_MEMBERS_SQL, groupMembers)
      const filed = new Set(lists.filter((x) => x.folderId).map((x) => x.id as string))
      return {
        folders: f.length,
        lists: l.length,
        groups: g.length,
        listMembers: lm.length,
        groupMembers: gm.length,
        skipped: {
          folders: folders.length - f.length,
          lists: lists.length - l.length,
          groups: groups.length - g.length,
          listMembers: listMembers.length - lm.length,
          groupMembers: groupMembers.length - gm.length,
        },
        outsideFolders: l.filter((x) => filed.has(x.id) && x.folderId === null).length,
      }
    },
    { maxWait: 10_000, timeout: 300_000 },
  )
}

function listsLine(r: ListsRestored): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const counts = (c: ListsRestored['skipped']) =>
    [n(c.folders, 'folder', 'folders'), n(c.lists, 'list', 'lists'), n(c.groups, 'group', 'groups'),
      n(c.listMembers, 'list membership', 'list memberships'), n(c.groupMembers, 'group membership', 'group memberships')].join(', ')
  const lines = [`folders, lists and groups restored: ${counts(r)}`]
  const skipped = Object.values(r.skipped).reduce((a, b) => a + b, 0)
  if (skipped > 0) lines.push(`skipped (another organization's id, or across organizations): ${counts(r.skipped)}`)
  if (r.outsideFolders > 0) lines.push(`${n(r.outsideFolders, 'list', 'lists')} put back outside folders (the folder isn't in its organization)`)
  return lines.join('\n')
}

async function main() {
  const file = scriptArgs()[0]
  if (!file) throw new Error('usage: restore-from-backup.ts <backup.json>')
  const data = JSON.parse(await fs.readFile(file, 'utf8'))

  // Order matters for FKs: org/user → lead → contact → phones/emails; defs → values.
  await upsertAll(data.organizations, (o) =>
    prisma.organization.upsert({ where: { id: o.id }, create: o, update: o })
  )
  await upsertAll(data.users, (u) => prisma.user.upsert({ where: { id: u.id }, create: u, update: u }))
  const nl = await upsertAll(data.leads, (l) => prisma.lead.upsert({ where: { id: l.id }, create: l, update: l }))
  await upsertAll(data.contacts, (c) => prisma.contact.upsert({ where: { id: c.id }, create: c, update: c }))
  await upsertAll(data.contactPhones, (p) =>
    prisma.contactPhone.upsert({ where: { id: p.id }, create: p, update: p })
  )
  await upsertAll(data.contactEmails, (e) =>
    prisma.contactEmail.upsert({ where: { id: e.id }, create: e, update: e })
  )
  await upsertAll(data.customFieldDefinitions, (d) =>
    prisma.customFieldDefinition.upsert({ where: { id: d.id }, create: d, update: d })
  )
  await upsertAll(data.customFieldValues, (v) =>
    prisma.customFieldValue.upsert({ where: { id: v.id }, create: v, update: v })
  )
  await upsertAll(data.savedViews, (s) =>
    prisma.savedView.upsert({ where: { id: s.id }, create: s, update: s })
  )
  await upsertAll(data.dealFlowDerivedSignals, (s) =>
    prisma.dealFlowDerivedSignal.upsert({ where: { id: s.id }, create: s, update: s })
  )
  // Brief 50 PR 7: after the leads, which the memberships point at.
  const lists = await restoreListsAndGroups(prisma, data)

  console.log(listsLine(lists))
  console.log(`restore complete from ${file} (${nl} leads restored)`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('restore failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
