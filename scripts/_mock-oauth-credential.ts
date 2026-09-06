import { prisma } from '../src/lib/prisma'
import { encryptToken } from '../src/lib/comms/oauth/crypto'

/**
 * In-memory stand-in for the OAuthCredential table, for smoke scripts.
 *
 * FLEET LANDMINE this exists to defuse: `upsertCredential` keys on
 * (organizationId, provider). Both smoke scripts used to `organization.upsert`
 * the REAL singleton org (`slug: 'dealflow-ryan'`) and then upsert a `gmail`
 * credential against it — so running `pnpm gate1:smoke` or `pnpm worker:smoke`
 * overwrote Ryan's live Gmail credential in place with 'mock-access' /
 * 'mock-refresh'. The AES-256-GCM originals are not recoverable from that.
 *
 * Replacing `upsertCredential` alone would NOT have been enough:
 * `resolveSendCredential` reads `prisma.oAuthCredential.findMany` directly and
 * then WRITES back through `updateAccessToken` on refresh, and the Gmail/Graph
 * runners write cursors via `updateGmailHistoryId` / `updateGraphDeltaLink`.
 * So the interception happens at the Prisma delegate: every read is served from
 * memory and every write is swallowed. After `installMockOAuthCredential()`,
 * no code path in the process can reach the real table.
 *
 * Same doctrine as scripts/_agentf-visual-seed.ts — never write OAuthCredential
 * from a seed, smoke script or test; mock the read path instead.
 */

export interface MockCredentialSpec {
  orgId: string
  provider: 'gmail' | 'msft-graph'
  emailAddress: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: Date
}

type Row = Record<string, unknown> & { id: string; organizationId: string; provider: string }

function makeRow(spec: MockCredentialSpec): Row {
  const now = new Date()
  return {
    id: `mockcred_${spec.provider}_${spec.orgId}`,
    organizationId: spec.orgId,
    userId: null,
    provider: spec.provider,
    // Encrypted with the real crypto so getDecryptedAccessToken/RefreshToken
    // round-trip exactly as they would against a stored row.
    accessTokenEncrypted: encryptToken(spec.accessToken ?? 'mock-access'),
    refreshTokenEncrypted: encryptToken(spec.refreshToken ?? 'mock-refresh'),
    scope: null,
    expiresAt: spec.expiresAt ?? new Date(Date.now() + 3_600_000),
    emailAddress: spec.emailAddress,
    gmailHistoryId: null,
    graphDeltaLink: null,
    gmailWatchExpiresAt: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Swap the `oAuthCredential` delegate for an in-memory one. Call ONCE, before
 * any smoke logic runs. Returns the seeded rows keyed by provider.
 */
export function installMockOAuthCredential(specs: MockCredentialSpec[]) {
  const rows = new Map<string, Row>()
  for (const s of specs) rows.set(`${s.orgId}:${s.provider}`, makeRow(s))

  const byCompositeKey = (where: any): Row | null => {
    const k = where?.organizationId_provider
    if (k) return rows.get(`${k.organizationId}:${k.provider}`) ?? null
    if (where?.id) {
      for (const r of rows.values()) if (r.id === where.id) return r
    }
    return null
  }

  const mock = {
    findUnique: async ({ where }: any) => byCompositeKey(where),
    findFirst: async ({ where }: any) => byCompositeKey(where),
    findMany: async ({ where }: any = {}) =>
      [...rows.values()].filter(
        (r) =>
          (where?.organizationId === undefined || r.organizationId === where.organizationId) &&
          (where?.status === undefined || r.status === where.status) &&
          (where?.provider === undefined || r.provider === where.provider),
      ),
    upsert: async ({ where, create, update }: any) => {
      const existing = byCompositeKey(where)
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() })
        return existing
      }
      const k = where.organizationId_provider
      const row = { ...makeRow({ orgId: k.organizationId, provider: k.provider, emailAddress: '' }), ...create }
      rows.set(`${k.organizationId}:${k.provider}`, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = byCompositeKey(where)
      if (!row) throw new Error(`mock oAuthCredential.update: no row for ${JSON.stringify(where)}`)
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
    delete: async ({ where }: any) => byCompositeKey(where),
    deleteMany: async () => ({ count: 0 }),
    count: async () => rows.size,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prisma as any).oAuthCredential = mock
  console.log(
    `✓ OAuthCredential mocked in-memory (${[...rows.values()].map((r) => r.provider).join(', ')}) — the real table is never touched`,
  )
  return { rows }
}
