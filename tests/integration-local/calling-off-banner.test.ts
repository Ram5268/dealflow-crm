import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '@/lib/prisma'
import { CallingOffBanner } from '@/components/CallingOffBanner'
import { IMPORT_SCORING_SOURCE } from '@/lib/core-data/dealflow-score/marker'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 45 PR F (from its independent review): the calling-off banner says
// "rankings use test buyers" when DealFlow's morning run used them. An upload's
// scoring writes signal rows later in the day; the banner must keep reading
// the newest MORNING row, never one of those. Made-up data.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45F_BANNER_${Date.now()}`
const MIN = 60_000

async function bannerText(organizationId: string): Promise<string> {
  const el = await CallingOffBanner({ organizationId })
  return el ? renderToStaticMarkup(el).replace(/<[^>]+>/g, '') : ''
}

describe.runIf(enabled)('CallingOffBanner reads the morning run, not an upload', () => {
  let orgId: string
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: { startsWith: TAG } } })
  })
  afterAll(async () => {
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: { startsWith: TAG } } })
  })

  const signals = async (morningFlag: boolean, uploadFlag: boolean) => {
    // The morning row is the newest morning row; the upload's row is newer still.
    await prisma.dealFlowDerivedSignal.create({ data: { organizationId: orgId, mojoId: `${TAG}_morning`, syncedAt: new Date(Date.now() - MIN),
      dealflowRawJson: { generatedAt: new Date(Date.now() - 120 * MIN).toISOString(), includeTestBuyers: morningFlag } } })
    await prisma.dealFlowDerivedSignal.create({ data: { organizationId: orgId, mojoId: `${TAG}_upload`, syncedAt: new Date(),
      dealflowRawJson: { source: IMPORT_SCORING_SOURCE, importId: 'imp_test', includeTestBuyers: uploadFlag } } })
  }

  it("the morning run used test buyers: says so, whatever a later upload's row says", async () => {
    vi.stubEnv('DIALING_ENABLED', '')
    await signals(true, false)
    expect(await bannerText(orgId)).toBe('Calling is off — rankings use test buyers')
  })

  it("the morning run used real buyers only: plain 'Calling is off', whatever a later upload's row says", async () => {
    vi.stubEnv('DIALING_ENABLED', '')
    await signals(false, true)
    expect(await bannerText(orgId)).toBe('Calling is off')
  })

  it('no banner while calling is on', async () => {
    vi.stubEnv('DIALING_ENABLED', 'true')
    expect(await CallingOffBanner({ organizationId: orgId })).toBeNull()
  })
})
