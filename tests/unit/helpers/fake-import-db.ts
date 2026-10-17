import { Prisma, type PrismaClient } from '@prisma/client'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'
import type { EmitResult } from '@/lib/core-data/events/emit'

// An in-memory stand-in for exactly the Prisma calls an import makes (claim,
// commit, status read), for the Brief 41.1 run-guard tests. No database.
//
// Each run gets its own client (a tag) so a test can hold up one run's calls
// with a gate. A batch write's WHERE is checked when the write lands, after
// any hold-up: that is how a late write from a stopped run is modelled.

export const ORG = 'org_fake'
export const BATCH = 'ib_fake'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const emitOk = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 })

export const phoneOf = (i: number) => `+1212664${String(1000 + i).slice(-4)}`
export const phoneCsv = (n: number) => 'Phone\n' + Array.from({ length: n }, (_, i) => phoneOf(i).slice(2)).join('\n') + '\n'

export const col = (column: string, field: string) => ({
  column, sampleValues: [], target: { kind: 'standard_field' as const, field }, confidence: 1, reasoning: '',
})
export const mappingOf = (...cols: ReturnType<typeof col>[]) => ({ mapping: cols, likelyDuplicates: [] }) as unknown as MappingProposal
export const PHONE_ONLY = mappingOf(col('Phone', 'ContactPhone.phone'))

// A promise a test releases by hand.
export function gate() {
  let release!: () => void
  let arrive!: () => void
  const g = {
    arrivals: 0,
    wait: new Promise<void>((r) => (release = r)),
    // Resolves when the first call reaches the gate.
    arrived: new Promise<void>((r) => (arrive = r)),
    release: () => release(),
    hold: () => {
      g.arrivals++
      arrive()
      return g.wait
    },
  }
  return g
}

export async function until(ok: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2)) if (ok()) return
  throw new Error('timed out waiting')
}

// A run's outcome without an unhandled rejection.
export const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }))

export interface FakeBatch {
  id: string
  organizationId: string
  userId: string
  sourceLabel: string
  filename: string
  storageKey: string
  sourceBlob: Buffer | null
  status: string
  mappingJson: unknown
  totalRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  errorRows: number
  errorLog: unknown
  createdAt: Date
  completedAt: Date | null
}

export interface FakeLead {
  id: string
  seq: number
  by: string
  phones: string[]
  name: string | null
  displayName: string
  primaryAddressFull: string | null
  mojoId: string | null
  statusLabel: string | null
  contacts: Array<{ id: string; name: string | null; displayName: string }>
}

export interface FakeCustomField {
  id: string
  name: string
  type: string
}

export interface FakeCustomValue {
  definitionId: string
  objectId: string
  valueText?: string | null
  valueNumber?: number | null
}

export interface BatchWrite {
  seq: number
  by: string
  data: Record<string, unknown>
  landed: boolean
  held: boolean
}

type Hook = (op: string, arg: unknown) => Promise<unknown> | void

const clone = <T>(v: T): T => (v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))
const canon = (v: unknown): string =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(canon).join(',')}]`
      : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(v)

function jsonMatches(cond: unknown, value: unknown): boolean {
  const c = cond as { path?: string[]; equals?: unknown }
  for (const k of Object.keys(c)) if (k !== 'path' && k !== 'equals') throw new Error(`fake db: unsupported Json filter ${k}`)
  if (c.path) {
    let x: unknown = value
    for (const p of c.path) x = x && typeof x === 'object' ? (x as Record<string, unknown>)[p] : undefined
    return x !== undefined && canon(x) === canon(c.equals)
  }
  if (c.equals === Prisma.DbNull) return value === null || value === undefined
  return value !== null && value !== undefined && canon(value) === canon(c.equals)
}

// The WHERE shapes the importer uses: equality, null, Date, { in }, { notIn },
// Json { path, equals } / { equals }. Anything else throws, so a test never
// passes on a filter the fake silently ignored.
export function matchesWhere(where: Record<string, unknown> | undefined, row: Record<string, unknown>): boolean {
  if (!where) return true
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k]
    if (k === 'mappingJson' || k === 'errorLog') {
      if (!jsonMatches(cond, v)) return false
    } else if (cond === null) {
      if (v !== null && v !== undefined) return false
    } else if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false
    } else if (typeof cond === 'object') {
      const c = cond as { in?: unknown[]; notIn?: unknown[] }
      for (const key of Object.keys(c)) if (key !== 'in' && key !== 'notIn') throw new Error(`fake db: unsupported filter ${k}.${key}`)
      if (c.in && !c.in.includes(v)) return false
      if (c.notIn && c.notIn.includes(v)) return false
    } else if (v !== cond) {
      return false
    }
  }
  return true
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>) {
  if (!select) return clone(row)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(select)) out[k] = row[k] instanceof Date || Buffer.isBuffer(row[k]) ? row[k] : clone(row[k])
  return out
}

export function importWorld(csv: string, init: Partial<FakeBatch> = {}) {
  const batch: FakeBatch = {
    id: BATCH,
    organizationId: ORG,
    userId: 'user_fake',
    sourceLabel: 'fake',
    filename: 'f.csv',
    storageKey: `imports/${ORG}/${BATCH}/f.csv`,
    sourceBlob: Buffer.from(csv),
    status: 'mapping_review',
    mappingJson: null,
    totalRows: 0,
    importedRows: 0,
    duplicateRows: 0,
    skippedRows: 0,
    errorRows: 0,
    errorLog: [],
    createdAt: new Date(),
    completedAt: null,
    ...init,
  }
  const leads: FakeLead[] = []
  const writes: BatchWrite[] = []
  // Custom fields: definitions a test adds, and the values the import writes
  // (one per field and lead, like the real unique key).
  const fields: FakeCustomField[] = []
  const values = new Map<string, FakeCustomValue>()
  let seq = 0

  const applyBatch = (data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) (batch as unknown as Record<string, unknown>)[k] = v instanceof Date ? new Date(v) : clone(v)
  }

  // A client for one run (tag). `before` may hold up an operation (return a
  // promise); `latency` adds a delay to every lead lookup or write.
  const db = (tag: string, hooks: { before?: Hook; latency?: number } = {}): PrismaClient => {
    const step = async (op: string, arg: unknown) => {
      const held = hooks.before?.(op, arg)
      if (held) await held
      if (hooks.latency) await sleep(hooks.latency)
      else await Promise.resolve()
    }
    // Contacts only when the query selects them, as Prisma does.
    const leadView = (l: FakeLead, select?: { contacts?: unknown }) => ({
      id: l.id, mojoId: l.mojoId, name: l.name, displayName: l.displayName,
      primaryAddressFull: l.primaryAddressFull, statusLabel: l.statusLabel,
      ...(select?.contacts ? { contacts: l.contacts.map((c) => ({ name: c.name, displayName: c.displayName })) } : {}),
    })
    const client = {
      importBatch: {
        async findUniqueOrThrow({ where }: { where: { id: string } }) {
          await step('importBatch.findUniqueOrThrow', where)
          if (where.id !== batch.id) throw new Error('No ImportBatch found')
          return pick(batch as unknown as Record<string, unknown>, Object.fromEntries(Object.keys(batch).map((k) => [k, true])))
        },
        async findUnique({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) {
          await step('importBatch.findUnique', where)
          return where.id === batch.id ? pick(batch as unknown as Record<string, unknown>, select) : null
        },
        async findFirst({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) {
          await step('importBatch.findFirst', where)
          return matchesWhere(where, batch as unknown as Record<string, unknown>) ? pick(batch as unknown as Record<string, unknown>, select) : null
        },
        async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
          const w: BatchWrite = { seq: ++seq, by: tag, data, landed: false, held: false }
          writes.push(w)
          await step('importBatch.update', { where, data, write: w })
          w.landed = where.id === batch.id
          if (w.landed) applyBatch(data)
          return clone(batch)
        },
        async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
          const w: BatchWrite = { seq: ++seq, by: tag, data, landed: false, held: false }
          writes.push(w)
          await step('importBatch.updateMany', { where, data, write: w })
          // Checked when the write lands, not when it was sent.
          w.landed = matchesWhere(where, batch as unknown as Record<string, unknown>)
          if (w.landed) applyBatch(data)
          return { count: w.landed ? 1 : 0 }
        },
      },
      customFieldDefinition: {
        async aggregate() {
          return { _max: { displayOrder: null } }
        },
        async findFirst({ where }: { where: { id: string } }) {
          return fields.find((d) => d.id === where.id) ?? null
        },
      },
      lead: {
        async findMany({ where, take, select }: { where: { contacts: { some: { phones: { some: { phone: string } } } } }; take?: number; select?: { contacts?: unknown } }) {
          const phone = where.contacts.some.phones.some.phone
          // A snapshot as of the query; the answer may arrive later.
          const found = leads.filter((l) => l.phones.includes(phone)).sort((a, b) => a.seq - b.seq).slice(0, take ?? 25).map((l) => leadView(l, select))
          await step('lead.findMany', { phone })
          return found
        },
        async findFirst({ where, select }: { where: { mojoId?: string; displayName?: string; primaryAddressFull?: string | null }; select?: { contacts?: unknown } }) {
          const found = leads.find((l) =>
            where.mojoId !== undefined
              ? l.mojoId === where.mojoId
              : l.displayName === where.displayName && l.primaryAddressFull === (where.primaryAddressFull ?? null)
          )
          await step('lead.findFirst', where)
          return found ? leadView(found, select) : null
        },
        async create({ data }: { data: Record<string, unknown> & { contacts: { create: { name: string | null; displayName: string; phones: { create: Array<{ phone: string }> } } } } }) {
          await step('lead.create', data)
          const id = `lead_${leads.length + 1}`
          const c = data.contacts.create
          leads.push({
            id, seq: ++seq, by: tag,
            phones: c.phones.create.map((p) => p.phone),
            name: (data.name as string | null) ?? null,
            displayName: data.displayName as string,
            primaryAddressFull: (data.primaryAddressFull as string | null) ?? null,
            mojoId: (data.mojoId as string | null) ?? null,
            statusLabel: (data.statusLabel as string | null) ?? null,
            contacts: [{ id: `c_${id}`, name: c.name, displayName: c.displayName }],
          })
          return { id }
        },
        async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
          await step('lead.update', data)
          const l = leads.find((x) => x.id === where.id)
          if (!l) throw new Error('No Lead found')
          for (const k of ['name', 'displayName', 'primaryAddressFull', 'statusLabel'] as const) if (k in data) (l as unknown as Record<string, unknown>)[k] = data[k]
          return { id: l.id }
        },
        async updateMany({ where, data }: { where: { id: string; mojoId: null }; data: { mojoId: string } }) {
          await step('lead.updateMany', data)
          const l = leads.find((x) => x.id === where.id && x.mojoId === null)
          if (l) l.mojoId = data.mojoId
          return { count: l ? 1 : 0 }
        },
      },
      contact: {
        async findFirst({ where }: { where: { leadId: string } }) {
          await step('contact.findFirst', where)
          const l = leads.find((x) => x.id === where.leadId)
          return l?.contacts[0] ? { id: l.contacts[0].id } : null
        },
        async create({ data }: { data: { leadId: string; name: string | null; displayName: string } }) {
          await step('contact.create', data)
          const l = leads.find((x) => x.id === data.leadId)!
          const c = { id: `c_${l.id}_${l.contacts.length}`, name: data.name, displayName: data.displayName }
          l.contacts.push(c)
          return { id: c.id }
        },
      },
      contactPhone: {
        async createMany({ data }: { data: Array<{ contactId: string; phone: string }> }) {
          await step('contactPhone.createMany', data)
          for (const p of data) {
            const l = leads.find((x) => x.contacts.some((c) => c.id === p.contactId))
            if (l && !l.phones.includes(p.phone)) l.phones.push(p.phone)
          }
          return { count: data.length }
        },
      },
      contactEmail: { async createMany() { return { count: 0 } } },
      customFieldValue: {
        // No await before the change, so a $transaction([deleteMany, createMany])
        // applies in order, as in Postgres.
        async createMany({ data, skipDuplicates }: { data: FakeCustomValue[]; skipDuplicates?: boolean }) {
          let count = 0
          for (const d of data) {
            const k = `${d.definitionId}|${d.objectId}`
            if (values.has(k)) {
              if (skipDuplicates) continue
              throw new Error('Unique constraint failed on (definitionId, objectId)')
            }
            values.set(k, { definitionId: d.definitionId, objectId: d.objectId, valueText: d.valueText ?? null, valueNumber: d.valueNumber ?? null })
            count++
          }
          return { count }
        },
        async deleteMany({ where }: { where: { objectId: string; definitionId: { in: string[] } } }) {
          let count = 0
          for (const [k, v] of values) {
            if (v.objectId === where.objectId && where.definitionId.in.includes(v.definitionId)) {
              values.delete(k)
              count++
            }
          }
          return { count }
        },
      },
      async $transaction(ops: Array<Promise<unknown>>) {
        return Promise.all(ops)
      },
    }
    return client as unknown as PrismaClient
  }

  return {
    batch,
    leads,
    writes,
    fields,
    values,
    db,
    // Leads per phone, for the "no homeowner twice" checks.
    duplicatePhones() {
      const byPhone = new Map<string, string[]>()
      for (const l of leads) for (const p of l.phones) byPhone.set(p, [...(byPhone.get(p) ?? []), `${l.id}(${l.by})`])
      return [...byPhone].filter(([, ls]) => ls.length > 1)
    },
    // Writes by `tag` that changed the batch and landed.
    landed(tag: string) {
      return writes.filter((w) => w.by === tag && w.landed)
    },
  }
}
