import 'dotenv/config'
import assert from 'node:assert/strict'
import { start as startGmail } from '../contracts/mocks/gmail/server'
import { getBoss, stopBoss } from '../src/lib/comms/jobs/boss'
import { QUEUES } from '../src/lib/comms/jobs/queues'
import { handleSendEmailJob } from '../src/lib/comms/jobs/outbound-email'
import { prisma } from '../src/lib/prisma'
import { installMockOAuthCredential } from './_mock-oauth-credential'
import { runSequenceTick } from '../src/lib/comms/sequences/tick'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Proves the pg-boss worker consumes a queued send-email job end-to-end: enqueue
 * → worker → sendEmailMessage → Gmail mock → Message.status='sent'.
 */
async function main() {
  const gmail = startGmail()
  process.env.GMAIL_MOCK_URL = 'http://localhost:4003'

  const org = await prisma.organization.upsert({
    where: { slug: 'dealflow-ryan' },
    update: {},
    create: { slug: 'dealflow-ryan', name: 'DealFlow (Ryan)' },
  })
  // NEVER write OAuthCredential from a smoke script — this is the REAL
  // singleton org and upsertCredential keys on (organizationId, provider), so a
  // write here would clobber Ryan's live Gmail tokens beyond recovery. The send
  // path's credential read is served from memory instead.
  installMockOAuthCredential([
    { orgId: org.id, provider: 'gmail', emailAddress: 'ryan@example.com' },
  ])
  const msg = await prisma.message.create({
    data: {
      organizationId: org.id,
      channel: 'email',
      direction: 'outgoing',
      status: 'outbox',
      fromAddress: '',
      toAddresses: ['buyer@example.com'],
      bodyText: 'worker smoke',
    },
  })

  const boss = await getBoss()
  await boss.work(QUEUES.SEND_EMAIL, handleSendEmailJob)
  await boss.send(QUEUES.SEND_EMAIL, { messageId: msg.id })

  let sent = false
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const m = await prisma.message.findUnique({ where: { id: msg.id } })
    if (m?.status === 'sent') {
      sent = true
      break
    }
  }
  assert(sent, 'worker processed the send-email job → Message.status=sent')
  console.log('✓ worker consumed send-email job → message sent')
  await prisma.message.deleteMany({ where: { id: msg.id } })

  // ── Phase 2: enrollment → tick → enqueue → worker → sent (tick wiring) ──
  const lead = await prisma.lead.create({
    data: { organizationId: org.id, displayName: 'Smoke Lead' },
  })
  const contact = await prisma.contact.create({
    data: {
      organizationId: org.id,
      leadId: lead.id,
      displayName: 'Pat Smoke',
      name: 'Pat Smoke',
      timezone: 'America/New_York',
    },
  })
  const tpl = await prisma.messageTemplate.create({
    data: {
      organizationId: org.id,
      name: 'smoke',
      channel: 'email',
      subject: 'Hi {{contact.firstName}}',
      bodyText: 'Hello {{contact.firstName}}',
      mergeFields: ['contact.firstName'],
    },
  })
  const seq = await prisma.sequence.create({
    data: {
      organizationId: org.id,
      name: 'smoke seq',
      channel: 'email',
      steps: { create: [{ ordinal: 1, delayHours: 0, channel: 'email', templateId: tpl.id }] },
    },
    include: { steps: true },
  })
  const enr = await prisma.sequenceEnrollment.create({
    data: {
      organizationId: org.id,
      sequenceId: seq.id,
      contactId: contact.id,
      status: 'active',
      currentStepId: seq.steps[0].id,
    },
  })

  const tickRes = await runSequenceTick() // real enqueue → SEND_EMAIL → worker
  assert(tickRes.sent >= 1, 'tick fired the due step')

  let tickSent = false
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const m = await prisma.message.findFirst({ where: { sequenceEnrollmentId: enr.id } })
    if (m?.status === 'sent') {
      tickSent = true
      break
    }
  }
  assert(tickSent, 'tick-enqueued message sent by worker')
  console.log('✓ enrollment → tick → enqueue → worker → message sent (tick wiring)')

  await prisma.message.deleteMany({ where: { sequenceEnrollmentId: enr.id } })
  await prisma.sequenceEnrollment.deleteMany({ where: { id: enr.id } })
  await prisma.sequence.deleteMany({ where: { id: seq.id } })
  await prisma.messageTemplate.deleteMany({ where: { id: tpl.id } })
  await prisma.contact.deleteMany({ where: { id: contact.id } })
  await prisma.lead.deleteMany({ where: { id: lead.id } })

  await stopBoss()
  gmail.close()
  await prisma.$disconnect()
  console.log('\nWORKER SMOKE: PASS')
  process.exit(0)
}

main().catch((err) => {
  console.error('\nWORKER SMOKE: FAIL\n', err)
  process.exit(1)
})
