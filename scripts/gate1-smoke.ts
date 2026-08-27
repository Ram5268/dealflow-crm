import 'dotenv/config'
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { start as startCompliance } from '../contracts/mocks/compliance/comms-mock'
import { start as startTwilio } from '../contracts/mocks/twilio/server'
import { start as startGmail } from '../contracts/mocks/gmail/server'
import { start as startGraph } from '../contracts/mocks/graph/server'
import { prisma } from '../src/lib/prisma'
import { upsertCredential, getCredential } from '../src/lib/comms/oauth/store'
import { sendEmailMessage } from '../src/lib/comms/email/send'
import { handleInboundSms } from '../src/lib/comms/sms/inbound'
import { scrub } from '../src/lib/comms/clients/compliance'
import { createGmailSyncPorts } from '../src/lib/comms/email/gmail-adapter'
import { deltaSync } from '../src/lib/comms/email/gmail-sync'
import { MessageReceivedEvent } from '../contracts/events/message.received'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cleanupSmokeRows() {
  await prisma.message.deleteMany({
    where: {
      OR: [
        { providerMessageId: { startsWith: 'gmail:<crm-' } },
        { providerMessageId: 'gmail:<buyer-1@mail.example.com>' },
        { providerMessageId: { startsWith: 'twilio:SMsmoke' } },
      ],
    },
  })
  await prisma.emailThread.deleteMany({ where: { providerThreadId: 'gmail:t1' } })
}

/**
 * Gate-1 behavioral smoke: exercises the three acceptance paths against the real
 * mocks + Railway DB (Agents A/B/C code absent). Drives the domain functions the
 * HTTP routes wrap, so each path is proven end-to-end deterministically.
 */
async function main() {
  const mocks = [startCompliance(), startTwilio(), startGmail(), startGraph()]
  process.env.COMPLIANCE_BASE_URL = 'http://localhost:4001'
  process.env.TWILIO_API_BASE = 'http://localhost:4002'
  process.env.GMAIL_MOCK_URL = 'http://localhost:4003'
  process.env.GRAPH_MOCK_URL = 'http://localhost:4004'
  await sleep(200)

  // 0. mock health
  for (const [name, port] of [
    ['compliance', 4001],
    ['twilio', 4002],
    ['gmail', 4003],
    ['graph', 4004],
  ] as const) {
    const res = await fetch(`http://localhost:${port}/_mock/health`)
    assert.equal(res.status, 200, `${name} mock health`)
  }
  console.log('✓ 4 mock /_mock/health → 200')

  await cleanupSmokeRows() // idempotent: clear rows from any prior failed run

  // seed singleton org + gmail credential
  const org = await prisma.organization.upsert({
    where: { slug: 'dealflow-ryan' },
    update: {},
    create: { slug: 'dealflow-ryan', name: 'DealFlow (Ryan)' },
  })
  const orgId = org.id
  await upsertCredential({
    orgId,
    provider: 'gmail',
    emailAddress: 'ryan@example.com',
    accessToken: 'mock-access',
    refreshToken: 'mock-refresh',
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  const cred = await getCredential(orgId, 'gmail')
  assert(cred, 'credential seeded')

  // ── Smoke A: outbound email → gmail mock → status sent (M3.5) ──────────────
  const outbox = await prisma.message.create({
    data: {
      organizationId: orgId,
      channel: 'email',
      direction: 'outgoing',
      status: 'outbox',
      fromAddress: '',
      toAddresses: ['buyer@example.com'],
      bodyText: 'hello from the Gate-1 smoke',
    },
  })
  const sent = await sendEmailMessage(outbox.id)
  assert.equal(sent.status, 'sent')
  const savedOut = await prisma.message.findUnique({ where: { id: outbox.id } })
  assert.equal(savedOut?.status, 'sent')
  assert(savedOut?.providerMessageId?.startsWith('gmail:<crm-'), 'client Message-ID pre-set for dedup')
  console.log('✓ email send → gmail mock → status:sent, client Message-ID set (M3.5)')

  // ── Smoke B: inbound STOP → compliance /dnc/internal → ledger blocks (M4) ──
  const stopPhone = '+15551239999'
  const before = await scrub([stopPhone])
  assert.equal(before[0].callable, true, 'callable before STOP')
  await handleInboundSms({
    orgId,
    from: stopPhone,
    to: '+15550000001',
    body: 'STOP',
    messageSid: 'SMsmoke1',
  })
  const after = await scrub([stopPhone])
  assert.equal(after[0].callable, false, 'blocked after STOP')
  assert(after[0].reasons.includes('internal_dnc'), 'internal_dnc reason')
  console.log('✓ inbound STOP → /dnc/internal 201 → phone now in DNC ledger (M4)')

  // ── Smoke C: Gmail delta → thread reconstructed → crm_message NOTIFY (M2) ──
  const pg = new Client({ connectionString: process.env.DATABASE_URL_MAIN })
  await pg.connect()
  await pg.query('LISTEN crm_message')
  const notifications: Array<Record<string, unknown>> = []
  pg.on('notification', (n) => {
    if (n.channel === 'crm_message' && n.payload) notifications.push(JSON.parse(n.payload))
  })

  const ports = createGmailSyncPorts({
    orgId,
    credentialId: cred.id,
    connectedEmail: 'ryan@example.com',
    accessToken: 'mock-access',
  })
  const res = await deltaSync(ports, '1')
  assert.equal(res.historyId, '999', 'historyId cursor advanced')
  await sleep(600)

  const thread = await prisma.emailThread.findUnique({ where: { providerThreadId: 'gmail:t1' } })
  assert(thread && thread.messageCount >= 1, 'EmailThread reconstructed')
  const inMsg = await prisma.message.findUnique({
    where: { providerMessageId: 'gmail:<buyer-1@mail.example.com>' },
  })
  assert(inMsg && inMsg.direction === 'incoming', 'inbound Message row')
  const evt = notifications.find((n) => n.messageId === inMsg.id)
  assert(evt, 'crm_message NOTIFY captured')
  MessageReceivedEvent.parse(evt) // valid frozen shape
  assert.equal(evt.channel, 'email')
  assert(!('eventName' in evt) && !('type' in evt), 'no discriminant leaked')
  console.log('✓ Gmail delta → thread reconstructed → crm_message NOTIFY (valid shape, M2)')

  await pg.query('UNLISTEN crm_message')
  await pg.end()

  await cleanupSmokeRows() // leave org + credential
  await prisma.$disconnect()
  for (const s of mocks) s.close()

  console.log('\nGATE 1 SMOKE: PASS')
  process.exit(0)
}

main().catch(async (err) => {
  console.error('\nGATE 1 SMOKE: FAIL\n', err)
  process.exit(1)
})
