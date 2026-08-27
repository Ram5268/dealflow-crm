import { prisma } from '@/lib/prisma'

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY emit helper (brief §6 emission rules):
//  - strips any accidental `eventName`/`type` discriminant before serializing —
//    routing is (channel, payload-shape), never an eventName field;
//  - Postgres NOTIFY payloads cap at 8000 bytes; anything over a 7500-byte safe
//    margin is spilled to NotifyOverflow and the wire carries a small
//    { overflow: true, overflowId, correlationId } pointer;
//  - deps are injectable so unit tests never need a DB.
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFY_SAFE_BYTES = 7500

export interface EmitDeps {
  notify: (channel: string, payload: string) => Promise<void>
  storeOverflow: (channel: string, payload: unknown) => Promise<string>
}

export interface EmitResult {
  overflow: boolean
  overflowId?: string
  bytes: number
}

// Removes routing-discriminant fields that must never travel on the wire.
export function stripDiscriminants<T extends Record<string, unknown>>(
  payload: T
): Omit<T, 'eventName' | 'type'> {
  const clone = { ...payload }
  delete (clone as Record<string, unknown>).eventName
  delete (clone as Record<string, unknown>).type
  return clone
}

export async function emitWith(
  deps: EmitDeps,
  channel: string,
  payload: Record<string, unknown>
): Promise<EmitResult> {
  const stripped = stripDiscriminants(payload)
  const serialized = JSON.stringify(stripped)
  const bytes = Buffer.byteLength(serialized, 'utf8')

  if (bytes > NOTIFY_SAFE_BYTES) {
    const overflowId = await deps.storeOverflow(channel, stripped)
    const pointer = JSON.stringify({
      overflow: true,
      overflowId,
      correlationId: (stripped as { correlationId?: string }).correlationId,
    })
    await deps.notify(channel, pointer)
    return { overflow: true, overflowId, bytes }
  }

  await deps.notify(channel, serialized)
  return { overflow: false, bytes }
}

const defaultDeps: EmitDeps = {
  notify: async (channel, payload) => {
    await prisma.$executeRawUnsafe('SELECT pg_notify($1, $2)', channel, payload)
  },
  storeOverflow: async (channel, payload) => {
    const row = await prisma.notifyOverflow.create({
      data: { channel, payload: payload as object },
    })
    return row.id
  },
}

export async function emit(
  channel: string,
  payload: Record<string, unknown>
): Promise<EmitResult> {
  return emitWith(defaultDeps, channel, payload)
}
